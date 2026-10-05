// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectSetup } from "./connect-view.js";
afterEach(cleanup);
it("shows local approval and clears the activation secret after linking", async () => {
  const call = vi.fn(async () => ({}));
  const act = vi.fn(async (work) => work());
  render(<ConnectSetup disabled={false} call={call} act={act} />);
  expect(
    screen.getByLabelText("Connect service").closest("details")?.open,
  ).toBe(false);
  fireEvent.click(screen.getByText("Advanced connection settings"));
  fireEvent.change(screen.getByLabelText("Connect service"), {
    target: { value: "https://connect.example.com" },
  });
  fireEvent.change(screen.getByLabelText("Activation code"), {
    target: { value: " secret-code " },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Approve Slack access on this computer",
    }),
  );
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("linkConnect", {
      origin: "https://connect.example.com",
      code: "secret-code",
    }),
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Activation code") as HTMLInputElement).value,
    ).toBe(""),
  );
});
it("focuses the private activation field for an explicit setup handoff", () => {
  render(
    <ConnectSetup
      focusCode
      disabled={false}
      call={vi.fn(async () => ({}))}
      act={vi.fn(async (work) => work())}
    />,
  );
  expect(document.activeElement).toBe(screen.getByLabelText("Activation code"));
});
it("shows the selected computer and an explicit unlink control", async () => {
  const call = vi.fn(async () => ({}));
  const act = vi.fn(async (work) => work());
  render(
    <ConnectSetup
      connection={{
        linked: true,
        computer: "My Mac",
        owner: "U123456",
        origin: "https://example.com",
      }}
      disabled={false}
      call={call}
      act={act}
    />,
  );
  expect(screen.getByText("My Mac")).toBeTruthy();
  expect(screen.queryByLabelText("Activation code")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Unlink Zana Connect" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith("unlinkConnect"));
});
