import { Env } from "..";
import { Authenticator, CompositeAuthenticator } from "./auth";
import { newRegistryTokens } from "./token";
import { UserAuthenticator } from "./user";
import type { AuthenticatorCredentials } from "./user";

// Builds the authenticator for the current configuration.
export async function authenticationMethodFromEnv(env: Env): Promise<Authenticator | undefined> {
  const authenticators: Authenticator[] = [];

  // Username/password credentials (full-access and/or read-only).
  const credentials: AuthenticatorCredentials[] = [];
  if (env.USERNAME && env.PASSWORD) {
    credentials.push({ username: env.USERNAME, password: env.PASSWORD, capabilities: ["pull", "push"] });
  }
  if (env.READONLY_USERNAME && env.READONLY_PASSWORD) {
    credentials.push({ username: env.READONLY_USERNAME, password: env.READONLY_PASSWORD, capabilities: ["pull"] });
  }
  if (credentials.length > 0) {
    authenticators.push(new UserAuthenticator(credentials));
  }

  // JWT public keys (full-access and/or read-only).
  if (env.JWT_REGISTRY_TOKENS_PUBLIC_KEY || env.READONLY_JWT_REGISTRY_TOKENS_PUBLIC_KEY) {
    authenticators.push(
      await newRegistryTokens(env.JWT_REGISTRY_TOKENS_PUBLIC_KEY, env.READONLY_JWT_REGISTRY_TOKENS_PUBLIC_KEY),
    );
  }

  if (authenticators.length === 0) {
    console.error(
      "Either env.JWT_REGISTRY_TOKENS_PUBLIC_KEY must be set or both env.USERNAME, env.PASSWORD must be set or both env.READONLY_USERNAME, env.READONLY_PASSWORD must be set.",
    );

    // invalid configuration
    return undefined;
  }

  // A single method needs no compositing.
  if (authenticators.length === 1) {
    return authenticators[0];
  }

  return new CompositeAuthenticator(authenticators);
}
