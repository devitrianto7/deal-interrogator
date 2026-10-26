import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deal Interrogator",
  description: "Cross-examines lifetime deals against their own fine print, with a quoted receipt for every finding.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
