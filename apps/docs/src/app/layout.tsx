import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Provider } from "@/components/provider";
import { appName } from "@/lib/shared";
import "./global.css";

export const metadata: Metadata = {
  title: { template: `%s | ${appName}`, default: `${appName} 문서` },
  description: "Werft 개발자 문서",
  // No icon yet; without one the browser asks the Pages host root for /favicon.ico.
  icons: { icon: "data:," },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
