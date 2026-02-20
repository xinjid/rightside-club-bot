const axios = require("axios");
const { maskSecret } = require("./logger");

const BILLING_GRAPHQL_URL = "https://billing.smartshell.gg/api/graphql";
const SMARTSHELL_COMPANY_ID = 2128;
const SMARTSHELL_OK_TTL_MS = 90 * 1000;

const LOGIN_MUTATION = `
mutation login($input: LoginInput!) {
  login(input: $input) {
    access_token
    refresh_token
    expires_in
  }
}
`;

const CLIENTS_QUERY = `
query clients($input: ClientsInput, $first: Int, $page: Int) {
  clients(input: $input, first: $first, page: $page) {
    data {
      id
      uuid
      nickname
      phone
      deposit
      bonus
      user_discount
      discounts {
        type
        value
      }
      group {
        uuid
        title
        discount
      }
      last_client_activity
      created_at
      banned_at
      unverified
    }
  }
}
`;

const SET_USER_DISCOUNT_MUTATION = `
mutation setUserDiscount($input: SetUserDiscountInput!) {
  setUserDiscount(input: $input) {
    uuid
    user_discount
    discounts {
      type
      value
      __typename
    }
    __typename
  }
}
`;

function normalizePhone(input) {
  const digits = String(input || "").replace(/\D/g, "");
  if (!digits) {
    return null;
  }
  if (digits.length === 11 && digits.startsWith("8")) {
    return `7${digits.slice(1)}`;
  }
  if (digits.length === 11 && digits.startsWith("7")) {
    return digits;
  }
  if (digits.length === 10) {
    return `7${digits}`;
  }
  return null;
}

function formatPhone(phoneDigits) {
  if (!phoneDigits) {
    return "—";
  }
  if (/^7\d{10}$/.test(phoneDigits)) {
    return `+${phoneDigits}`;
  }
  return String(phoneDigits);
}

function extractGraphQLError(data) {
  if (!data?.errors?.length) {
    return "";
  }
  return data.errors.map((entry) => entry.message).join("; ");
}

function isAuthError(error) {
  if (!error) {
    return false;
  }
  if (error.response?.status === 401) {
    return true;
  }
  const text = String(error.message || "").toLowerCase();
  return (
    text.includes("401") ||
    text.includes("unauthor") ||
    text.includes("unauthenticated") ||
    text.includes("jwt") ||
    text.includes("token")
  );
}

class SmartShellClient {
  constructor({ logger, getSettings }) {
    this.logger = logger;
    this.getSettings = getSettings;
    this.cachedAccessToken = "";
    this.cachedExpiresAt = 0;
    this.cachedAuthKey = "";
    this.lastSuccessAt = 0;
    this.lastError = "";
  }

  getConnectionStatus() {
    const ok = Date.now() - this.lastSuccessAt <= SMARTSHELL_OK_TTL_MS;
    return {
      ok,
      lastSuccessAt: this.lastSuccessAt || null,
      lastError: this.lastError || null,
      endpoint: BILLING_GRAPHQL_URL,
      companyId: SMARTSHELL_COMPANY_ID,
    };
  }

  resolveSettings(overrides = {}) {
    const base = this.getSettings ? this.getSettings() : {};
    const merged = {
      ...base,
      ...overrides,
    };

    const smartshell = merged.smartshell || {};
    const authMode =
      smartshell.authMode ||
      merged.smartshellAuthMode ||
      merged.authMode ||
      "credentials";

    return {
      login: String(smartshell.login || merged.smartshellLogin || "").trim(),
      password: String(smartshell.password || merged.smartshellPassword || ""),
      authMode,
      bearerToken: String(
        smartshell.bearerToken || merged.smartshellBearerToken || ""
      ).trim(),
    };
  }

  async testConnection(overrides = {}) {
    await this.searchClients("70000000000", overrides);
    return {
      ok: true,
      message: "SmartShell подключен успешно",
    };
  }

  async searchClients(query, overrides = {}) {
    const settings = this.resolveSettings(overrides);
    const q = String(query || "").trim();
    const data = await this.#requestGraphQL(
      {
        query: CLIENTS_QUERY,
        variables: {
          input: {
            q,
            sort: {
              field: "last_client_activity",
              direction: "DESC",
            },
          },
          first: 1,
          page: 1,
        },
      },
      settings,
      {
        operationLabel: "clients",
      }
    );
    return data?.clients?.data || [];
  }

  async findClientByPhone(phoneInput, overrides = {}) {
    const normalized = normalizePhone(phoneInput);
    if (!normalized) {
      throw new Error("Номер не распознан. Пример: +79991234567");
    }
    const list = await this.searchClients(normalized, overrides);
    return list[0] || null;
  }

  async findClientByQuery(queryInput, overrides = {}) {
    const list = await this.searchClients(String(queryInput || "").trim(), overrides);
    return list[0] || null;
  }

  async findClientByUuid(uuid, overrides = {}) {
    if (!uuid) {
      throw new Error("UUID не указан");
    }
    const list = await this.searchClients(String(uuid).trim(), overrides);
    const exact = list.find((entry) => String(entry.uuid || "").toLowerCase() === String(uuid).toLowerCase());
    return exact || list[0] || null;
  }

  async setUserDiscount(clientUuid, value, overrides = {}) {
    if (!clientUuid) {
      throw new Error("client_uuid не указан");
    }

    const settings = this.resolveSettings(overrides);
    const data = await this.#requestGraphQL(
      {
        operationName: "setUserDiscount",
        query: SET_USER_DISCOUNT_MUTATION,
        variables: {
          input: {
            client_uuid: String(clientUuid),
            value: Number(value),
          },
        },
      },
      settings,
      {
        operationLabel: "setUserDiscount",
      }
    );
    return data?.setUserDiscount || null;
  }

  async #requestGraphQL(payload, settings, meta = {}, retried = false) {
    const token = await this.#getAccessToken(settings, false);

    try {
      const response = await axios.post(BILLING_GRAPHQL_URL, payload, {
        timeout: 20000,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });

      const gqlError = extractGraphQLError(response.data);
      if (gqlError) {
        if (!retried && settings.authMode === "credentials" && isAuthError(new Error(gqlError))) {
          this.logger.warn(`SmartShell ${meta.operationLabel || "request"} unauthorized, relogin retry`);
          await this.#getAccessToken(settings, true);
          return this.#requestGraphQL(payload, settings, meta, true);
        }
        this.lastError = gqlError;
        throw new Error(gqlError);
      }

      this.lastSuccessAt = Date.now();
      this.lastError = "";
      return response.data?.data;
    } catch (error) {
      if (!retried && settings.authMode === "credentials" && isAuthError(error)) {
        this.logger.warn(`SmartShell ${meta.operationLabel || "request"} 401, relogin retry`);
        await this.#getAccessToken(settings, true);
        return this.#requestGraphQL(payload, settings, meta, true);
      }

      const message = error.response?.data?.message || error.message || "Unknown SmartShell error";
      this.lastError = message;
      throw new Error(message);
    }
  }

  async #getAccessToken(settings, forceRefresh) {
    if (settings.authMode === "bearer") {
      this.cachedAccessToken = "";
      this.cachedExpiresAt = 0;
      this.cachedAuthKey = "";
      if (!settings.bearerToken) {
        throw new Error("Bearer token пустой");
      }
      return settings.bearerToken;
    }

    if (!forceRefresh && this.cachedAccessToken && Date.now() < this.cachedExpiresAt) {
      return this.cachedAccessToken;
    }

    if (!settings.login || !settings.password) {
      throw new Error("Для SmartShell login заполните логин и пароль");
    }

    const authKey = `${settings.login}|${SMARTSHELL_COMPANY_ID}`;
    if (this.cachedAuthKey !== authKey) {
      this.cachedAccessToken = "";
      this.cachedExpiresAt = 0;
    }

    this.logger.info(`SmartShell login attempt user=${settings.login} company_id=${SMARTSHELL_COMPANY_ID}`);
    const response = await axios.post(
      BILLING_GRAPHQL_URL,
      {
        query: LOGIN_MUTATION,
        variables: {
          input: {
            login: settings.login,
            password: settings.password,
            company_id: SMARTSHELL_COMPANY_ID,
          },
        },
      },
      {
        timeout: 20000,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    const gqlError = extractGraphQLError(response.data);
    if (gqlError) {
      this.lastError = gqlError;
      throw new Error(gqlError);
    }

    const loginResult = response.data?.data?.login;
    if (!loginResult?.access_token) {
      throw new Error("SmartShell login не вернул access_token");
    }

    const accessToken = String(loginResult.access_token);
    const expiresIn = Number(loginResult.expires_in || 3600);
    this.cachedAccessToken = accessToken;
    this.cachedExpiresAt = Date.now() + Math.max(60, expiresIn - 20) * 1000;
    this.cachedAuthKey = authKey;
    this.lastSuccessAt = Date.now();
    this.lastError = "";
    this.logger.info(`SmartShell login ok token=${maskSecret(accessToken)}`);
    return accessToken;
  }
}

module.exports = {
  SmartShellClient,
  BILLING_GRAPHQL_URL,
  SMARTSHELL_COMPANY_ID,
  normalizePhone,
  formatPhone,
};
