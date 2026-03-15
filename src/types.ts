// Minimal Octokit interface — compatible with both @octokit/rest
// and the octokit instance provided by @octokit/app webhooks
export interface OctokitClient {
  request: (route: string, options?: Record<string, unknown>) => Promise<{ data: unknown }>;
}
