import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Statehouse Atlas | State legislative districts",
  description: "Explore state legislative districts and their current officeholders across all 50 states.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
