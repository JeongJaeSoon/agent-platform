import { describe, expect, test } from "bun:test";
import type { ProfileSummary } from "@werft-ai/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../i18n/i18n.tsx";
import { ProfileOptions, pickable } from "./profile-options.tsx";

const ceiling = (
  id: string,
  state?: NonNullable<ProfileSummary["installation"]>["state"],
) =>
  ({
    id,
    source: "operator",
    ...(state === undefined ? {} : { installation: { state } }),
  }) as ProfileSummary;

const version = (
  id: string,
  state: NonNullable<ProfileSummary["workspace"]>["state"],
) => ({ id, source: "workspace", workspace: { state } }) as ProfileSummary;

describe("profile options", () => {
  test("only a usable ceiling or version is pickable; a ceiling with no state still is", () => {
    expect(
      [
        ceiling("old-server"),
        ceiling("a", "usable"),
        ceiling("b", "retired"),
        ceiling("c", "connection_missing"),
        version("ws_a", "usable"),
        version("ws_b", "base_retired"),
      ].map((profile) => [profile.id, pickable(profile)]),
    ).toEqual([
      ["old-server", true],
      ["a", true],
      ["b", false],
      ["c", false],
      ["ws_a", true],
      ["ws_b", false],
    ]);
  });

  test("a ceiling that cannot be picked is disabled and says why", () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <select>
          <ProfileOptions
            profiles={[
              ceiling("live", "usable"),
              ceiling("gone", "retired"),
              ceiling("elsewhere", "runtime_unsupported"),
            ]}
            label={(profile) => profile.id}
          />
        </select>
      </I18nProvider>,
    );
    const options = [
      ...html.matchAll(/value="([^"]+)"( disabled="")?>([^<]*)</g),
    ].map(([, value, disabled, text]) => [value, disabled !== undefined, text]);
    expect(options).toEqual([
      ["live", false, "live"],
      ["gone", true, "gone · Turned off"],
      ["elsewhere", true, "elsewhere · Runtime not supported"],
    ]);
  });
});
