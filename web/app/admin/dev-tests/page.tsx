"use client";

// DEV-TOOLS (temporary): delete this folder before the real deploy (DEV-TOOLS-REMOVAL.md).
import { TestRunnerPanel } from "@/components/devtests/TestRunnerPanel";
import { PageTitle } from "@/components/ui";

export default function DevTestsPage() {
  return (
    <>
      <PageTitle>รันเทสต์อัตโนมัติ</PageTitle>
      <TestRunnerPanel />
    </>
  );
}
