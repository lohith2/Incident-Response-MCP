/**
 * CloudWatch Logs integration.
 *
 * Requires: npm install @aws-sdk/client-cloudwatch-logs
 * Credentials are resolved from the standard AWS credential chain
 * (env vars, ~/.aws/credentials, IAM role, etc.)
 *
 * Dynamic import is used so the server starts even if the SDK is absent;
 * a clear error is thrown only when a CloudWatch tool is actually invoked.
 */

export interface LogEvent {
  timestamp: number;
  message: string;
  logStreamName: string;
}

async function getSdkClients(region: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import("@aws-sdk/client-cloudwatch-logs" as any);
    const client = new mod.CloudWatchLogsClient({ region });
    return { client, mod };
  } catch {
    throw new Error(
      "CloudWatch integration requires @aws-sdk/client-cloudwatch-logs — run: npm install @aws-sdk/client-cloudwatch-logs",
    );
  }
}

export async function queryLogGroup(
  logGroupName: string,
  filterPattern: string,
  startTime: number,
  endTime: number,
  limit = 100,
): Promise<LogEvent[]> {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const { client, mod } = await getSdkClients(region);

  const command = new mod.FilterLogEventsCommand({
    logGroupName,
    filterPattern,
    startTime,
    endTime,
    limit,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: any = await client.send(command);
  return (response.events ?? []).map((e: any) => ({
    timestamp: e.timestamp ?? 0,
    message: e.message ?? "",
    logStreamName: e.logStreamName ?? "",
  }));
}

export async function describeLogGroups(prefix?: string, limit = 50): Promise<string[]> {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const { client, mod } = await getSdkClients(region);

  const command = new mod.DescribeLogGroupsCommand({
    logGroupNamePrefix: prefix,
    limit,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: any = await client.send(command);
  return (response.logGroups ?? []).map((g: any) => g.logGroupName ?? "");
}
