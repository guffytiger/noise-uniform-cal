import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Noise Uniform Calculator",
  description: "ระบบคำนวณ Uniformity, Noise และ Dose จากผลการวัดทางรังสี",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="th" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
