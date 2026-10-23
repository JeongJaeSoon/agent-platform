import type { Metadata } from "next";
import { LocaleRedirect } from "@/components/locale-redirect";
import { appName } from "@/lib/shared";

export const metadata: Metadata = {
  title: appName,
  icons: { icon: "data:," },
};

export default function Page() {
  return <LocaleRedirect path="/" />;
}
