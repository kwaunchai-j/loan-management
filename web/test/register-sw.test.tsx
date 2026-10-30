import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegisterServiceWorker } from "@/components/RegisterServiceWorker";

function stubServiceWorker(register: ReturnType<typeof vi.fn> | null) {
  Object.defineProperty(navigator, "serviceWorker", { value: register ? { register } : undefined, configurable: true });
  if (!register) delete (navigator as unknown as Record<string, unknown>).serviceWorker;
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

describe("RegisterServiceWorker", () => {
  it("registers /sw.js for the whole site in a production build", () => {
    vi.stubEnv("NODE_ENV", "production");
    const register = vi.fn(async () => ({}));
    stubServiceWorker(register);
    render(<RegisterServiceWorker />);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
  });

  it("does nothing in development (a service worker would only get in the way)", () => {
    vi.stubEnv("NODE_ENV", "development");
    const register = vi.fn(async () => ({}));
    stubServiceWorker(register);
    render(<RegisterServiceWorker />);
    expect(register).not.toHaveBeenCalled();
  });

  it("does nothing, and does not crash, in a browser without service workers", () => {
    vi.stubEnv("NODE_ENV", "production");
    stubServiceWorker(null);
    expect(() => render(<RegisterServiceWorker />)).not.toThrow();
  });

  it("the app keeps working when registration is refused", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const register = vi.fn(() => Promise.reject(new Error("refused")));
    stubServiceWorker(register);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    render(<RegisterServiceWorker />);
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", unhandled);
    expect(register).toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("renders nothing visible", () => {
    const { container } = render(<RegisterServiceWorker />);
    expect(container).toBeEmptyDOMElement();
  });
});
