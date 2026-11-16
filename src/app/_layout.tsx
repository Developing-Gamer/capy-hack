import { ConvexProvider, ConvexReactClient } from 'convex/react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

const convex = new ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL ?? 'https://glorious-heron-969.convex.cloud', { unsavedChangesWarning: false });

export default function RootLayout() {
  return (
    <ConvexProvider client={convex}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0b0908' } }} />
    </ConvexProvider>
  );
}
