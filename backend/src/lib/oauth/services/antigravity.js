import open from "open";
import { ANTIGRAVITY_CONFIG, getOAuthClientMetadata } from "../constants/oauth.js";
import { getServerCredentials } from "../config/index.js";
import { startLocalServer } from "../utils/server.js";
import { generatePKCE } from "../utils/pkce.js";
import { spinner as createSpinner } from "../utils/ui.js";

// The Antigravity Google client only has http://localhost:51121/oauth-callback
// registered. A random port (the previous behavior) produces
// redirect_uri_mismatch. Keep this exact value for the CLI flow too.
export const ANTIGRAVITY_CLI_REDIRECT_URI = "http://localhost:51121/oauth-callback";

/**
 * Antigravity OAuth Service
 * Uses standard OAuth2 Authorization Code flow (similar to Gemini)
 */
export class AntigravityService {
  constructor() {
    this.config = {
      ...ANTIGRAVITY_CONFIG,
      clientId: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || ANTIGRAVITY_CONFIG.clientId,
      clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() || ANTIGRAVITY_CONFIG.clientSecret,
    };
  }

  /**
   * Build Antigravity authorization URL
   */
  buildAuthUrl(redirectUri, state, codeChallenge) {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: this.config.scopes.join(" "),
      state: state,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    });
    if (codeChallenge) {
      params.set("code_challenge", codeChallenge);
      params.set("code_challenge_method", "S256");
    }

    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(code, redirectUri, codeVerifier) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code: code,
      redirect_uri: redirectUri,
    });
    if (codeVerifier) body.set("code_verifier", codeVerifier);

    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    return await response.json();
  }

  /**
   * Get user info from Google
   */
  async getUserInfo(accessToken) {
    const response = await fetch(`${this.config.userInfoUrl}?alt=json`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get user info: ${error}`);
    }

    return await response.json();
  }

  /**
   * Get common headers for Antigravity API calls
   */
  getApiHeaders(accessToken) {
    return {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": this.config.loadCodeAssistUserAgent,
      "X-Goog-Api-Client": this.config.loadCodeAssistApiClient,
      "Client-Metadata": this.config.loadCodeAssistClientMetadata,
    };
  }

  /**
   * Get metadata object for loadCodeAssist / onboardUser API calls.
   * Uses numeric enum values matching Antigravity binary ClientMetadata.
   */
  getMetadata() {
    return getOAuthClientMetadata();
  }

  /**
   * Fetch Project ID and Tier from loadCodeAssist API
   */
  async loadCodeAssist(accessToken) {
    const response = await fetch(this.config.loadCodeAssistEndpoint, {
      method: "POST",
      headers: this.getApiHeaders(accessToken),
      body: JSON.stringify({ metadata: this.getMetadata() }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to load code assist: ${errorText}`);
    }

    const data = await response.json();

    // Extract project ID
    let projectId = data.cloudaicompanionProject;
    if (typeof projectId === 'object' && projectId !== null && projectId.id) {
      projectId = projectId.id;
    }

    // Extract tier ID (default to legacy-tier)
    let tierId = "legacy-tier";
    if (Array.isArray(data.allowedTiers)) {
      for (const tier of data.allowedTiers) {
        if (tier.isDefault && tier.id) {
          tierId = tier.id.trim();
          break;
        }
      }
    }

    return { projectId, tierId, raw: data };
  }

  /**
   * Onboard user to enable Gemini Code Assist for the project
   */
  async onboardUser(accessToken, projectId, tierId) {
    const response = await fetch(this.config.onboardUserEndpoint, {
      method: "POST",
      headers: this.getApiHeaders(accessToken),
      body: JSON.stringify({ tierId, metadata: this.getMetadata() }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to onboard user: ${errorText}`);
    }

    return await response.json();
  }

  /**
   * Complete onboarding flow with retry
   */
  async completeOnboarding(accessToken, projectId, tierId, maxRetries = 10) {
    for (let i = 0; i < maxRetries; i++) {
      const result = await this.onboardUser(accessToken, projectId, tierId);

      if (result.done === true) {
        // Extract final project ID from response
        let finalProjectId = projectId;
        if (result.response?.cloudaicompanionProject) {
          const respProject = result.response.cloudaicompanionProject;
          if (typeof respProject === 'string') {
            finalProjectId = respProject.trim();
          } else if (respProject.id) {
            finalProjectId = respProject.id.trim();
          }
        }
        return { success: true, projectId: finalProjectId };
      }

      // Wait 5 seconds before retry
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    throw new Error("Onboarding timeout - please try again");
  }

  /**
   * Fetch Project ID from loadCodeAssist API (legacy method for compatibility)
   */
  async fetchProjectId(accessToken) {
    const { projectId } = await this.loadCodeAssist(accessToken);
    if (!projectId) {
      throw new Error("No cloudaicompanionProject found in response");
    }
    return projectId;
  }

  /**
   * Save Antigravity tokens to server
   */
  async saveTokens(tokens, userInfo, projectId) {
    const { server, token, userId } = getServerCredentials();

    const response = await fetch(`${server}/api/cli/providers/antigravity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-User-Id": userId,
      },
      body: JSON.stringify({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        scope: tokens.scope,
        email: userInfo.email,
        projectId: projectId, // Send projectId to server
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to save tokens");
    }

    return await response.json();
  }

  /**
   * Complete Antigravity OAuth flow
   */
  async connect() {
    const spinner = createSpinner("Starting Antigravity OAuth...").start();

    try {
      spinner.text = "Starting local server...";

      // The registered Antigravity callback is a FIXED loopback URI. Using a
      // random port (the old behavior) causes Google's redirect_uri_mismatch.
      let callbackParams = null;
      const { port, close } = await startLocalServer((params) => {
        callbackParams = params;
      }, 51121);

      const redirectUri = ANTIGRAVITY_CLI_REDIRECT_URI;
      spinner.succeed(`Local server started on port ${port}`);

      const { codeVerifier, codeChallenge, state } = generatePKCE();

      // Build authorization URL
      const authUrl = this.buildAuthUrl(redirectUri, state, codeChallenge);

      console.log("\nOpening browser for Antigravity authentication...");
      console.log(`If browser doesn't open, visit:\n${authUrl}\n`);

      // Open browser
      await open(authUrl);

      // Wait for callback
      spinner.start("Waiting for Antigravity authorization...");

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Authentication timeout (5 minutes)"));
        }, 300000);

        const checkInterval = setInterval(() => {
          if (callbackParams) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 100);
      });

      close();

      if (callbackParams.error) {
        throw new Error(callbackParams.error_description || callbackParams.error);
      }

      if (!callbackParams.code) {
        throw new Error("No authorization code received");
      }
      if (callbackParams.state !== state) {
        throw new Error("Antigravity OAuth state mismatch — restart the login flow.");
      }

      spinner.start("Exchanging code for tokens...");

      // Exchange code for tokens using the exact redirect URI and PKCE
      // verifier from the authorization request.
      const tokens = await this.exchangeCode(callbackParams.code, redirectUri, codeVerifier);

      spinner.text = "Fetching user info...";

      // Get user info
      const userInfo = await this.getUserInfo(tokens.access_token);

      spinner.text = "Loading Code Assist configuration...";

      // Load Code Assist to get project ID and tier
      const { projectId, tierId } = await this.loadCodeAssist(tokens.access_token);

      if (!projectId) {
        throw new Error("No Google Cloud Project found. Please ensure you have a GCP project with Gemini Code Assist enabled.");
      }

      spinner.text = "Onboarding to Gemini Code Assist...";

      // Complete onboarding to enable Gemini Code Assist
      const onboardResult = await this.completeOnboarding(tokens.access_token, projectId, tierId);
      const finalProjectId = onboardResult.projectId || projectId;

      spinner.text = "Saving tokens to server...";

      // Save tokens to server
      await this.saveTokens(tokens, userInfo, finalProjectId);

      spinner.succeed(`Antigravity connected successfully! (${userInfo.email}, Project: ${finalProjectId})`);
      return true;
    } catch (error) {
      spinner.fail(`Failed: ${error.message}`);
      throw error;
    }
  }
}

