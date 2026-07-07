#!/usr/bin/env node
// Generate ES256 signing keys and JWTs for the registry's JWT authentication.
//
// The output is byte-compatible with src/token.ts (same base64-encoded JWK
// format, same ES256 signing via @tsndr/cloudflare-worker-jwt, and the same
// token payload). Verification only checks the signature, `exp`, and
// `capabilities`, so a token minted here is accepted by the deployed Worker.
//
//   node scripts/jwt.mjs genkey
//   node scripts/jwt.mjs sign --private <base64> --full
//   node scripts/jwt.mjs sign --private-file key.txt --readonly --exp 30
//
// (or via pnpm: `pnpm jwt genkey`, `pnpm jwt sign --readonly --private <base64>`)

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import jwt from "@tsndr/cloudflare-worker-jwt";
import { decode } from "@cfworker/base64url";

const USAGE = `Usage:
  node scripts/jwt.mjs genkey
      Generate an ECDSA P-256 keypair. Set the PUBLIC key as a Worker secret
      (JWT_REGISTRY_TOKENS_PUBLIC_KEY for full access, or
      READONLY_JWT_REGISTRY_TOKENS_PUBLIC_KEY for pull-only), keep the PRIVATE
      key safe and use it to sign tokens.

  node scripts/jwt.mjs sign [options]
      Sign a token with a private key. The token is used as the *password* in
      Docker/podman login (any username works).

      --private <base64>       Private key from 'genkey' (base64 JWK).
      --private-file <path>    Read the private key from a file instead.
                               (or set REGISTRY_JWT_PRIVATE_KEY in the env)
      --readonly               Token can only pull (capabilities: pull).
      --full                   Token can pull and push (default).
      --caps <list>            Explicit comma-separated capabilities, e.g. pull,push.
      --exp <minutes>          Expiry in minutes (default: 60).
      --aud <url>              Audience / registry URL (optional).
      --account <id>           account_id claim (default: cli).
`;

function fail(message) {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

async function genkey() {
  // Mirrors RegistryTokens.createPrivateAndPublicKey() in src/token.ts.
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateKey = btoa(JSON.stringify(await crypto.subtle.exportKey("jwk", key.privateKey)));
  const publicKey = btoa(JSON.stringify(await crypto.subtle.exportKey("jwk", key.publicKey)));

  console.log("# Public key — set as a Worker secret:");
  console.log("#   full access : npx wrangler secret put JWT_REGISTRY_TOKENS_PUBLIC_KEY --env production");
  console.log("#   pull-only   : npx wrangler secret put READONLY_JWT_REGISTRY_TOKENS_PUBLIC_KEY --env production");
  console.log(publicKey);
  console.log();
  console.log("# Private key — keep secret, use it with 'sign' to mint tokens:");
  console.log(privateKey);
}

async function sign() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      "private": { type: "string" },
      "private-file": { type: "string" },
      "readonly": { type: "boolean" },
      "full": { type: "boolean" },
      "caps": { type: "string" },
      "exp": { type: "string" },
      "aud": { type: "string" },
      "account": { type: "string" },
    },
  });

  let privateKey = values.private ?? process.env.REGISTRY_JWT_PRIVATE_KEY;
  if (values["private-file"]) {
    privateKey = readFileSync(values["private-file"], "utf8").trim();
  }
  if (!privateKey) {
    fail("provide the private key via --private, --private-file, or REGISTRY_JWT_PRIVATE_KEY");
  }

  // Resolve capabilities: --readonly / --full / --caps, defaulting to full access.
  let capabilities;
  if (values.caps) {
    capabilities = values.caps.split(",").map((capability) => capability.trim());
  } else if (values.readonly) {
    capabilities = ["pull"];
  } else {
    capabilities = ["pull", "push"];
  }
  const invalid = capabilities.filter((capability) => capability !== "pull" && capability !== "push");
  if (invalid.length > 0) {
    fail(`unknown capabilities: ${invalid.join(", ")} (allowed: pull, push)`);
  }

  const expirationMinutes = values.exp ? Number(values.exp) : 60;
  if (!Number.isFinite(expirationMinutes) || expirationMinutes <= 0) {
    fail(`--exp must be a positive number of minutes (got ${values.exp})`);
  }

  let privateKeyJwk;
  try {
    privateKeyJwk = JSON.parse(decode(privateKey));
  } catch {
    fail("could not parse the private key — it must be the base64 value printed by 'genkey'");
  }

  // Keep this payload in sync with RegistryTokens.createToken() in src/token.ts.
  const payload = {
    username: "v0",
    account_id: values.account ?? "cli",
    capabilities,
    exp: Math.floor(Date.now() / 1000) + 60 * expirationMinutes,
    aud: values.aud ?? "",
  };

  const token = await jwt.sign(payload, privateKeyJwk, { algorithm: "ES256" });
  console.log(token);
}

const subcommand = process.argv[2];
switch (subcommand) {
  case "genkey":
    await genkey();
    break;
  case "sign":
    await sign();
    break;
  case undefined:
  case "help":
  case "-h":
  case "--help":
    console.log(USAGE);
    break;
  default:
    fail(`unknown command: ${subcommand}`);
}
