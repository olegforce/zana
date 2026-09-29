#!/usr/bin/env node
/* Adapted from get-bb/bb apps/mobile/scripts/testflight-distribute.mjs.
MIT License

Copyright (c) 2026 Michael Yong

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const ASC_BASE_URL = "https://api.appstoreconnect.apple.com";
const POLL_INTERVAL_MS = 30_000;

export function parseArgs(argv) {
  const options = {
    version: "",
    build: "",
    group: "External testers",
    keyPath: "./asc-api-key.p8",
    timeoutMinutes: 45,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--version":
        options.version = value ?? "";
        break;
      case "--build":
        options.build = value ?? "";
        break;
      case "--group":
        options.group = value ?? "";
        break;
      case "--key-path":
        options.keyPath = value ?? "";
        break;
      case "--timeout-minutes":
        options.timeoutMinutes = Number(value);
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
    index += 1;
  }
  if (!/^\d+\.\d+\.\d+$/u.test(options.version)) {
    throw new Error(`--version must be X.Y.Z, got '${options.version}'.`);
  }
  if (!/^\d+(\.\d+){0,2}$/u.test(options.build)) {
    throw new Error(`--build must be a build number, got '${options.build}'.`);
  }
  if (!options.group) {
    throw new Error("--group must be a beta group name.");
  }
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0 || options.timeoutMinutes > 120) {
    throw new Error("--timeout-minutes must be between 1 and 120.");
  }
  return options;
}

export function readSubmitConfig(easConfig = JSON.parse(readFileSync("eas.json", "utf8"))) {
  const ios = easConfig?.submit?.production?.ios;
  const keyId = ios?.ascApiKeyId;
  const issuerId = ios?.ascApiKeyIssuerId;
  const appId = ios?.ascAppId;
  if (
    typeof keyId !== "string" ||
    typeof issuerId !== "string" ||
    typeof appId !== "string"
  ) {
    throw new Error(
      "eas.json submit.production.ios needs ascApiKeyId, ascApiKeyIssuerId, and ascAppId.",
    );
  }
  return { keyId, issuerId, appId };
}

export function signJwt({ keyId, issuerId, privateKey }) {
  const base64url = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "ES256", kid: keyId, typ: "JWT" });
  const payload = base64url({
    iss: issuerId,
    iat: now,

    exp: now + 15 * 60,
    aud: "appstoreconnect-v1",
  });
  const signature = createSign("SHA256")
    .update(`${header}.${payload}`)
    .sign({ key: privateKey, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export function createClient(auth, fetcher = fetch) {
  let token = signJwt(auth);
  let tokenIssuedAt = Date.now();
  return async function request(method, path, body) {
    if (Date.now() - tokenIssuedAt > 10 * 60 * 1000) {
      token = signJwt(auth);
      tokenIssuedAt = Date.now();
    }
    const response = await fetcher(`${ASC_BASE_URL}${path}`, {
      redirect: "error", signal: AbortSignal.timeout(30_000),
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`App Store Connect ${method} failed (${response.status}). Check the release account configuration in App Store Connect.`);
    }
    return text ? JSON.parse(text) : null;
  };
}

export async function findBetaGroup(request, appId, groupName) {
  const result = await request(
    "GET",
    `/v1/betaGroups?filter[app]=${appId}&fields[betaGroups]=name,isInternalGroup&limit=200`,
  );
  const matches = result.data.filter(entry => entry.attributes.name === groupName);
  if (matches.length > 1) throw new Error('Beta group name is ambiguous. Use a unique name.');
  const group = matches[0];
  if (!group) {
    const names = result.data.map((entry) => entry.attributes.name);
    throw new Error(
      `Beta group '${groupName}' not found. Groups: ${names.join(", ") || "(none)"}.`,
    );
  }
  return {
    id: group.id,
    isInternal: group.attributes.isInternalGroup === true,
  };
}

export async function waitForBuild(
  request,
  { appId, version, build, timeoutMinutes },
  { now = Date.now, pause = sleep } = {},
) {
  const deadline = now() + timeoutMinutes * 60 * 1000;
  const query = new URLSearchParams({
    "filter[app]": appId,
    "filter[preReleaseVersion.version]": version,
    "filter[version]": build,
    "fields[builds]":
      "version,processingState,expired,betaAppReviewSubmission,betaGroups",
    include: "betaAppReviewSubmission,betaGroups",
    "fields[betaAppReviewSubmissions]": "betaReviewState",
    "fields[betaGroups]": "name",
  });
  for (;;) {
    const result = await request("GET", `/v1/builds?${query}`);
    const matches = result.data.filter(entry => !entry.attributes.expired && entry.attributes.version === build);
    if (matches.length > 1) throw new Error('Multiple builds match the requested version.');
    const found = matches[0];
    if (found) {
      const state = found.attributes.processingState;
      if (state === "VALID") {
        const included = result.included ?? [];
        const submission = included.find(
          (entry) =>
            entry.type === "betaAppReviewSubmissions" &&
            entry.id === found.relationships?.betaAppReviewSubmission?.data?.id,
        );
        return {
          id: found.id,
          reviewState: submission?.attributes.betaReviewState ?? null,
          groupIds: (found.relationships?.betaGroups?.data ?? []).map(
            (entry) => entry.id,
          ),
        };
      }
      if (state === "FAILED" || state === "INVALID") {
        throw new Error(
          `Build ${version} (${build}) has processingState ${state}.`,
        );
      }
      console.log(`Build ${version} (${build}) is ${state}; waiting.`);
    } else {
      console.log(
        `Build ${version} (${build}) is not in App Store Connect yet; waiting.`,
      );
    }
    if (now() >= deadline) {
      throw new Error(
        `Build ${version} (${build}) did not become VALID within ${timeoutMinutes} minutes.`,
      );
    }
    await pause(POLL_INTERVAL_MS);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { keyId, issuerId, appId } = readSubmitConfig();
  const privateKey = readFileSync(options.keyPath, "utf8");
  const request = createClient({ keyId, issuerId, privateKey });

  await distribute(request, appId, options);
}

export async function distribute(request, appId, options) {
  const group = await findBetaGroup(request, appId, options.group);
  const build = await waitForBuild(request, {
    appId,
    version: options.version,
    build: options.build,
    timeoutMinutes: options.timeoutMinutes,
  });
  console.log(
    `Build ${options.version} (${options.build}) is VALID; review state: ${build.reviewState ?? "none"}.`,
  );

  if (build.groupIds.includes(group.id)) {
    console.log(`Build is already in '${options.group}'. Nothing to do.`);
    return;
  }

  if (['REJECTED', 'INVALID', 'DEVELOPER_REJECTED'].includes(build.reviewState)) {
    throw new Error(`Beta review is ${build.reviewState}; resolve it in App Store Connect before distributing.`);
  }
  if (!group.isInternal && build.reviewState === null) {
    await request("POST", "/v1/betaAppReviewSubmissions", {
      data: {
        type: "betaAppReviewSubmissions",
        relationships: { build: { data: { type: "builds", id: build.id } } },
      },
    });
    console.log("Submitted the build for Beta App Review.");
  }

  await request("POST", `/v1/betaGroups/${group.id}/relationships/builds`, {
    data: [{ type: "builds", id: build.id }],
  });
  console.log(
    `Added build ${options.version} (${options.build}) to '${options.group}'. External availability still depends on Apple Beta App Review.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
