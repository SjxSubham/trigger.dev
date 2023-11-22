import {
  type ConnectionType,
  type Integration,
  type IntegrationConnection,
} from "@trigger.dev/database";
import type { PrismaClient, PrismaClientOrTransaction } from "~/db.server";
import { $transaction, prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { ResumeRunService } from "./resumeRun.server";
import { createHash } from "node:crypto";

type FoundRun = NonNullable<Awaited<ReturnType<typeof findRun>>>;
type RunConnectionsByKey = Awaited<ReturnType<typeof createRunConnections>>;

export class StartRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const run = await findRun(this.#prismaClient, id);

    if (!run || !this.#runIsStartable(run)) {
      return;
    }

    const runConnectionsByKey = await createRunConnections(this.#prismaClient, run);

    if (hasMissingConnections(runConnectionsByKey)) {
      await this.#handleMissingConnections(id, runConnectionsByKey);
    } else {
      await this.#startRun(id, run, runConnectionsByKey);
    }
  }

  #runIsStartable(run: FoundRun) {
    const startableStatuses = ["PENDING", "WAITING_ON_CONNECTIONS"] as const;
    return startableStatuses.includes(run.status);
  }

  async #startRun(id: string, run: FoundRun, runConnectionsByKey: RunConnectionsByKey) {
    const createRunConnections = Object.entries(runConnectionsByKey)
      .map(([key, runConnection]) =>
        runConnection.result === "resolvedHosted"
          ? ({
              key,
              connectionId: runConnection.connection.id,
              integrationId: runConnection.integration.id,
              authSource: "HOSTED",
            } as const)
          : runConnection.result === "resolvedLocal" || runConnection.result === "resolvedResolver"
          ? ({
              key,
              integrationId: runConnection.integration.id,
              authSource: runConnection.result === "resolvedLocal" ? "LOCAL" : "RESOLVER",
            } as const)
          : undefined
      )
      .filter(Boolean);
    const lockId = jobIdToLockId(run.jobId);

    await $transaction(
      this.#prismaClient,
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;

        const counter = await tx.jobCounter.upsert({
          where: { jobId: run.jobId },
          update: { lastNumber: { increment: 1 } },
          create: { jobId: run.jobId, lastNumber: 1 },
          select: { lastNumber: true },
        });

        const updatedRun = await this.#prismaClient.jobRun.update({
          where: { id },
          data: {
            number: counter.lastNumber,
            status: "QUEUED",
            queuedAt: new Date(),
            runConnections: {
              create: createRunConnections,
            },
          },
        });

        await ResumeRunService.enqueue(updatedRun, tx);
      },
      { timeout: 60000 }
    );
  }

  async #handleMissingConnections(id: string, runConnectionsByKey: RunConnectionsByKey) {
    const missingConnections = Object.values(runConnectionsByKey)
      .map((runConnection) => (runConnection.result === "missing" ? runConnection : undefined))
      .filter(Boolean);

    const updatedRun = await this.#prismaClient.jobRun.update({
      where: { id },
      data: {
        status: "WAITING_ON_CONNECTIONS",
        missingConnections: {
          connectOrCreate: missingConnections.map((connection) => ({
            where: {
              integrationId_connectionType_accountIdentifier: {
                integrationId: connection.integration.id,
                connectionType: connection.connectionType,
                accountIdentifier: connection.externalAccountId ?? "DEVELOPER",
              },
            },
            create: {
              integrationId: connection.integration.id,
              connectionType: connection.connectionType,
              accountIdentifier: connection.externalAccountId ?? "DEVELOPER",
              externalAccountId: connection.externalAccountId,
              resolved: false,
            },
          })),
        },
      },
      include: {
        missingConnections: {
          include: {
            _count: {
              select: { runs: true },
            },
          },
        },
      },
    });

    for (const missingConnection of updatedRun.missingConnections) {
      if (missingConnection._count.runs === 1) {
        workerQueue.enqueue("missingConnectionCreated", {
          id: missingConnection.id,
        });
      }
    }
  }
}

async function findRun(tx: PrismaClientOrTransaction, id: string) {
  return await tx.jobRun.findUnique({
    where: { id },
    include: {
      queue: true,
      environment: true,
      version: {
        include: {
          integrations: {
            include: {
              integration: true,
            },
          },
        },
      },
    },
  });
}

async function createRunConnections(tx: PrismaClientOrTransaction, run: FoundRun) {
  return await run.version.integrations.reduce(
    async (
      accP: Promise<
        Record<
          string,
          | {
              result: "resolvedHosted";
              connection: IntegrationConnection;
              integration: Integration;
            }
          | { result: "resolvedLocal"; integration: Integration }
          | { result: "resolvedResolver"; integration: Integration }
          | {
              result: "missing";
              connectionType: ConnectionType;
              integration: Integration;
              externalAccountId?: string;
            }
        >
      >,
      jobIntegration
    ) => {
      const acc = await accP;

      if (jobIntegration.integration.authSource === "LOCAL") {
        acc[jobIntegration.key] = {
          result: "resolvedLocal",
          integration: jobIntegration.integration,
        };
      } else if (jobIntegration.integration.authSource === "RESOLVER") {
        acc[jobIntegration.key] = {
          result: "resolvedResolver",
          integration: jobIntegration.integration,
        };
      } else {
        const connection = run.externalAccountId
          ? await tx.integrationConnection.findFirst({
              where: {
                integrationId: jobIntegration.integration.id,
                connectionType: "EXTERNAL",
                externalAccountId: run.externalAccountId,
              },
            })
          : await tx.integrationConnection.findFirst({
              where: {
                integrationId: jobIntegration.integration.id,
                connectionType: "DEVELOPER",
              },
            });

        if (connection) {
          acc[jobIntegration.key] = {
            result: "resolvedHosted",
            connection,
            integration: jobIntegration.integration,
          };
        } else {
          acc[jobIntegration.key] = {
            result: "missing",
            connectionType: run.externalAccountId ? "EXTERNAL" : "DEVELOPER",
            externalAccountId: run.externalAccountId ?? undefined,
            integration: jobIntegration.integration,
          };
        }
      }

      return acc;
    },
    Promise.resolve({})
  );
}

function hasMissingConnections(runConnectionsByKey: RunConnectionsByKey) {
  return Object.values(runConnectionsByKey).some((connection) => connection.result === "missing");
}

function jobIdToLockId(jobId: string): number {
  // Convert jobId to a unique lock identifier
  return parseInt(createHash("sha256").update(jobId).digest("hex").slice(0, 8), 16);
}
