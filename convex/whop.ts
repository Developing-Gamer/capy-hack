import { action } from "./_generated/server";

const API = {
  sandbox: "https://sandbox-api.whop.com/api/v1",
  production: "https://api.whop.com/api/v1",
};

const environment = () => (process.env.WHOP_ENVIRONMENT === "production" ? "production" : "sandbox");

export async function whop(path: string, init?: RequestInit & { headers?: Record<string, string> }) {
  const env = environment();
  const res = await fetch(`${API[env]}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.WHOP_API_KEY}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`Whop ${env} API returned ${res.status}: ${await res.text()}`);
  return res.json();
}

export const company = action({
  args: {},
  handler: async () => {
    const company = await whop(`/companies/${process.env.WHOP_COMPANY_ID}`);
    return { environment: environment(), id: company.id as string, title: company.title as string };
  },
});
