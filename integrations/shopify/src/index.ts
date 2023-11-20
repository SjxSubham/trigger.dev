import {
  TriggerIntegration,
  RunTaskOptions,
  IO,
  IOTask,
  IntegrationTaskKey,
  RunTaskErrorCallback,
  Json,
  retry,
  ConnectionAuth,
} from "@trigger.dev/sdk";

import {
  ApiVersion,
  HttpRetriableError,
  HttpThrottlingError,
  LATEST_API_VERSION,
  LogSeverity,
  Session,
  shopifyApi,
  ShopifyError,
} from "@shopify/shopify-api";

// this has to be updated manually with each LATEST_API_VERSION bump
import { restResources, type RestResources } from "@shopify/shopify-api/rest/admin/2023-10";
import "@shopify/shopify-api/adapters/node";

import { ApiScope, WebhookTopic } from "./schemas";
import { triggerCatalog } from "./triggers";
import {
  TriggerParams,
  Webhooks,
  createTrigger,
  createWebhookEventSource,
} from "./webhooks";
import { Rest, restProxy } from "./rest";
import { OmitIndexSignature } from "@trigger.dev/integration-kit/types";

export type ShopifyRestResources = OmitIndexSignature<RestResources>;

export type ShopifyIntegrationOptions = {
  id: string;
  apiKey?: string;
  apiSecretKey: string;
  apiVersion?: ApiVersion;
  adminAccessToken: string;
  hostName: string;
  scopes?: ApiScope[];
  session?: Session;
};

export type ShopifyRunTask = InstanceType<typeof Shopify>["runTask"];

export class Shopify implements TriggerIntegration {
  private _options: ShopifyIntegrationOptions;

  private _client?: ReturnType<(typeof this)["createClient"]>;
  private _io?: IO;
  private _connectionKey?: string;
  private _session?: Session;
  private _shopDomain: string;

  constructor(private options: ShopifyIntegrationOptions) {
    if (Object.keys(options).includes("apiKey") && !options.apiKey) {
      throw `Can't create Shopify integration (${options.id}) as apiKey was undefined`;
    }

    this._options = options;
    this._shopDomain = this._options.hostName.replace("http://", "").replace("https://", "");
  }

  get authSource() {
    return this._options.apiKey ? "LOCAL" : "HOSTED";
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "shopify", name: "Shopify" };
  }

  get clientSecret() {
    return this._options.apiSecretKey;
  }

  get #source() {
    return createWebhookEventSource(this);
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const shopify = new Shopify(this._options);

    const client = this.createClient(auth);

    const session = client.session.customAppSession(client.config.hostName);
    session.accessToken = client.config.adminApiAccessToken;

    shopify._io = io;
    shopify._connectionKey = connectionKey;
    shopify._client = client;
    shopify._session = this._options.session ?? session;

    return shopify;
  }

  createClient(auth?: ConnectionAuth) {
    // oauth
    // if (auth) {
    //   return shopifyApi({
    //     apiKey: this._options.apiKey,
    //     apiSecretKey: auth.accessToken,
    //     adminApiAccessToken: this._options.adminAccessToken,
    //     apiVersion: this._options.apiVersion ?? LATEST_API_VERSION,
    //     hostName: this._shopDomain,
    //     scopes: auth.scopes,
    //     restResources: this._options.restResources ?? restResources,
    //     isCustomStoreApp: false,
    //     isEmbeddedApp: true,
    //     logger: {
    //       level: LogSeverity.Warning,
    //     },
    //   });
    // }

    // apiKey auth
    if (this._options.apiKey) {
      return shopifyApi({
        apiKey: this._options.apiKey,
        apiSecretKey: this._options.apiKey,
        adminApiAccessToken: this._options.adminAccessToken,
        apiVersion: this._options.apiVersion ?? LATEST_API_VERSION,
        hostName: this._shopDomain,
        restResources,
        // TODO: double check this
        isCustomStoreApp: true,
        isEmbeddedApp: false,
        logger: {
          level: LogSeverity.Warning,
        },
      });
    }

    throw new Error("No auth");
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (
      client: ReturnType<Shopify["createClient"]>,
      task: IOTask,
      io: IO,
      session: Session
    ) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ): Promise<TResult> {
    if (!this._io) throw new Error("No IO");
    if (!this._connectionKey) throw new Error("No connection key");

    return this._io.runTask<TResult>(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        if (!this._session) throw new Error("No session");
        return callback(this._client, task, io, this._session);
      },
      {
        icon: "shopify",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback ?? onError
    );
  }

  on<TTopic extends WebhookTopic>(topic: TTopic, params?: Omit<TriggerParams, "topic">) {
    const { eventSpec, params: catalogParams } = triggerCatalog[topic];

    return createTrigger(this.#source, eventSpec, {
      ...params,
      ...catalogParams,
    });
  }

  get #webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }

  get rest() {
    if (!this._session) {
      throw new Error("No session");
    }

    return restProxy(
      new Rest(this.runTask.bind(this), this._session),
      this._session,
      this.runTask.bind(this)
    );
  }
}

export function onError(error: unknown): ReturnType<RunTaskErrorCallback> {
  if (!(error instanceof ShopifyError)) {
    return;
  }

  if (!(error instanceof HttpRetriableError)) {
    return {
      skipRetrying: true,
    };
  }

  if (!(error instanceof HttpThrottlingError)) {
    return;
  }

  const retryAfter = error.response.retryAfter;

  if (retryAfter) {
    const retryAfterMs = Number(retryAfter) * 1000;

    if (Number.isNaN(retryAfterMs)) {
      return;
    }

    const resetDate = new Date(Date.now() + retryAfterMs);

    return {
      retryAt: resetDate,
      error,
    };
  }
}
