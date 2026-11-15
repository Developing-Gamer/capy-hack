import { action } from "./_generated/server";

const API = {
  sandbox: "https://sandbox-api.whop.com/api/v1",
  production: "https://api.whop.com/api/v1",
};

export const company = action({
  args: {},
  handler: async () => {
    const env = process.env.WHOP_ENVIRONMENT === "production" ? "production" : "sandbox";
    const res = await fetch(`${API[env]}/companies/${process.env.WHOP_COMPANY_ID}`, {
      headers: { Authorization: `Bearer ${process.env.WHOP_API_KEY}` },
    });
    if (!res.ok) throw new Error(`Whop ${env} API returned ${res.status}`);
    const company = await res.json();
    return { environment: env, id: company.id as string, title: company.title as string };
  },
});
