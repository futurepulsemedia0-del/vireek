// Pushes a booked appointment into Jobber as a real Job via GraphQL.
// Docs: https://developer.getjobber.com/docs/ — Jobber's job creation
// flow normally goes Client -> Property -> Request/Quote -> Job. This
// does the minimal client+job path; extend to quotes if you need pricing
// approval before the job is created.

const JOBBER_API = "https://api.getjobber.com/api/graphql";

interface PushJobInput {
  accessToken: string;
  customerName: string;
  phone: string;
  address: string | null;
  serviceType: string;
  scheduledStart: string;
  scheduledEnd: string;
}

export interface PushJobResult {
  ok: boolean;
  externalJobId?: string;
  error?: string;
}

async function gql(accessToken: string, query: string, variables: Record<string, unknown>) {
  const res = await fetch(JOBBER_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-JOBBER-GRAPHQL-VERSION": "2023-11-15", // TODO: pin to whatever version you certify against
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data;
}

export async function pushJobToJobber(input: PushJobInput): Promise<PushJobResult> {
  try {
    const clientData = await gql(
      input.accessToken,
      `mutation CreateClient($input: ClientCreateInput!) {
        clientCreate(input: $input) { client { id } userErrors { message } }
      }`,
      { input: { firstName: input.customerName, phones: [{ number: input.phone }] } },
    );
    const clientId = clientData.clientCreate.client?.id;
    if (!clientId) return { ok: false, error: "jobber_client_create_failed" };

    const jobData = await gql(
      input.accessToken,
      `mutation CreateJob($input: JobCreateInput!) {
        jobCreate(input: $input) { job { id } userErrors { message } }
      }`,
      {
        input: {
          clientId,
          title: `${input.serviceType} — booked by Sarah AI`,
          startAt: input.scheduledStart,
          endAt: input.scheduledEnd,
        },
      },
    );
    const jobId = jobData.jobCreate.job?.id;
    if (!jobId) return { ok: false, error: "jobber_job_create_failed" };
    return { ok: true, externalJobId: jobId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
