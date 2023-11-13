import { Outlet } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import {
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTabs,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { requireUser } from "~/services/session.server";
import {
  TriggerSourceParamSchema,
  projectWebhookTriggersPath,
  webhookDeliveryPath,
  webhookTriggerPath,
} from "~/utils/pathBuilder";
import { RunListSearchSchema } from "../_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam._index/route";
import { WebhookSourcePresenter } from "~/presenters/WebhookSourcePresenter.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, triggerParam } = TriggerSourceParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = RunListSearchSchema.parse(s);

  const presenter = new WebhookSourcePresenter();
  const { trigger } = await presenter.call({
    userId: user.id,
    organizationSlug,
    projectSlug: projectParam,
    webhookId: triggerParam,
    direction: searchParams.direction,
    cursor: searchParams.cursor,
  });

  if (!trigger) {
    throw new Response("Trigger not found", {
      status: 404,
      statusText: "Not Found",
    });
  }

  return typedjson({ trigger });
};

export default function Page() {
  const { trigger } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageContainer>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle
            title={`${trigger.integration.title}: ${trigger.integration.slug}`}
            backButton={{
              to: projectWebhookTriggersPath(organization, project),
              text: "Webhook Triggers",
            }}
          />
        </PageTitleRow>
        <PageInfoRow>runList
          <PageInfoGroup>
            <PageInfoProperty
              icon={trigger.integration.definition.icon ?? trigger.integration.definitionId}
              label={trigger.integration.title ?? ""}
              value={trigger.integration.slug}
            />
            <PageInfoProperty
              label={trigger.active ? "Active" : "Inactive"}
              value={
                <NamedIcon name={trigger.active ? "active" : "inactive"} className="h-4 w-4" />
              }
            />
            <PageInfoProperty
              label="Environment"
              value={<EnvironmentLabel environment={trigger.environment} />}
            />
          </PageInfoGroup>
        </PageInfoRow>
        <PageTabs
          layoutId="webhook-trigger"
          tabs={[
            {
              label: "Registration Runs",
              to: webhookTriggerPath(organization, project, trigger),
            },
            {
              label: "Delivery Runs",
              to: webhookDeliveryPath(organization, project, trigger),
            },
          ]}
        />
      </PageHeader>

      <PageBody scrollable={false}>
        <div className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
          <Outlet />
        </div>
      </PageBody>
    </PageContainer>
  );
}