# Meat Market

Machine Party on your phone: everyone pays a $10 buy-in, losing a trial costs a limb, and the last subject alive takes the pot.

## Stack

- **Expo** (Expo Router, TypeScript) app in `src/`
- **Convex** backend in `convex/`: rooms and players, an OpenAI action for The Host's lines, and a Whop connectivity check
- **OpenAI** and **Whop** keys live only in the Convex deployment environment (`npx convex env list`), never in the app

## Run it

```bash
npm install
npx convex dev      # syncs functions and writes .env.local
npx expo start
```

`.env` holds the public `EXPO_PUBLIC_CONVEX_URL` so cloud builds can reach the dev deployment.

## Convex environment

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | `ai:hostLine` |
| `WHOP_API_KEY`, `WHOP_COMPANY_ID` | Whop API |
| `WHOP_ENVIRONMENT` | `sandbox` (default) or `production` |
