import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { useSession } from "@/lib/session-store";
import { pathnameMock, routerMock } from "./mocks";

vi.mock("next/navigation", async () => {
  const m = await import("./mocks");
  return { useRouter: () => m.routerMock, usePathname: () => m.pathnameMock.value };
});

// jsdom has no object URLs; the slip picker previews the chosen image with one
URL.createObjectURL = vi.fn(() => "blob:preview");
URL.revokeObjectURL = vi.fn();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  routerMock.replace.mockReset();
  routerMock.push.mockReset();
  pathnameMock.value = "/";
  useSession.setState({ status: "loading", user: null });
});
