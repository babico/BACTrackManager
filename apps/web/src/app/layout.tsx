import type { Metadata } from "next";
import "leaflet/dist/leaflet.css";
import "./globals.css";
import { AuthProvider } from "./auth-context";
import { Nav } from "./nav";

export const metadata: Metadata = { title: "BACTrackManager" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <Nav />
          <main>{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
