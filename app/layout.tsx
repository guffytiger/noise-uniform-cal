import type { Metadata } from "next";
import "./globals.css";
import { Inter } from "next/font/google";
import { cn } from "@/lib/utils";

const inter = Inter({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: "Noise Uniform Calculator",
  description: "ระบบคำนวณ Uniformity, Noise และ Dose จากผลการวัดทางรังสี",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="th" className={cn("h-full antialiased", "font-sans", inter.variable)}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
