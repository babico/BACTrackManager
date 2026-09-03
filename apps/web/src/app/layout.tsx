import type { Metadata } from "next";
import { AuthProvider } from "./auth-context";
import { Nav } from "./nav";

export const metadata: Metadata = { title: "BACTrackManager" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <AuthProvider>
          <Nav />
          <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
