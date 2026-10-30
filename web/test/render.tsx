import { act, render } from "@testing-library/react";
import { Suspense, type ComponentType } from "react";

/** Renders a page that reads its route params with React's use(): the promise settles inside an async act. */
export async function renderPage(Page: ComponentType<{ params: Promise<{ id: string }> }>, id: string) {
  const params = Promise.resolve({ id });
  await act(async () => {
    render(
      <Suspense fallback="loading">
        <Page params={params} />
      </Suspense>,
    );
  });
}

/** Makes "today" a fixed day in Thailand (Date only: timers keep running, so user-event still works). */
export { vi } from "vitest";
