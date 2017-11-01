/* @flow */

import fetch from 'node-fetch';
import { fromPairs } from 'lodash';
import { RUNNER_WRAPPER } from './code';
import type { Context, Dependency } from './types';

const UNPKG_URL = 'https://unpkg.com';
const WEBTASK_API_URL = 'https://webtask.it.auth0.com/api';

const CORE_DEPENDENCIES = [
  {
    name: 'graphql',
    version: '0.11.7',
  },
  {
    name: 'graphql-tools',
    version: '2.6.1',
  },
  {
    name: 'apollo-tracing',
    version: '0.1.1',
  },
  {
    name: 'graphql-extensions',
    version: '0.0.5',
  },
  {
    name: 'apollo-engine',
    version: '0.5.2',
  },
  {
    name: 'express',
    version: '4.16.2',
  },
  {
    name: 'webtask-tools',
    version: '3.2.0',
  },
  {
    name: 'body-parser',
    version: '1.18.2',
  },
  {
    name: 'express-graphql',
    version: '0.6.11',
  },
];

class WebtaskProvider {
  webtaskUrl: string;
  token: string;
  tokens: { [string]: string };
  singleTenantContainer: ?string;
  noProxy: boolean;

  constructor({
    token,
    webtaskUrl,
    singleTenantContainer,
    noProxy,
  }: {
    token: string,
    webtaskUrl: ?string,
    singleTenantContainer: ?string,
    noProxy: boolean,
  }) {
    this.webtaskUrl = webtaskUrl || WEBTASK_API_URL;
    this.token = token;
    this.tokens = {};
    this.singleTenantContainer = singleTenantContainer || null;
    this.noProxy = Boolean(noProxy);
  }

  async query({
    endpoint,
    method,
    body,
    token,
    useText = false,
  }: {
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body: any,
    token?: string,
    useText?: boolean,
  }): Promise<{ ok: boolean, response: any }> {
    if (!token) {
      token = this.token;
    }
    const url = `${this.webtaskUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    const fetchResult = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(body),
    });

    let response;
    if (useText) {
      response = await fetchResult.text();
    } else {
      response = await fetchResult.json();
    }

    return {
      ok: fetchResult.ok,
      response,
    };
  }

  async getToken(containerId: string): Promise<string> {
    if (!this.tokens[containerId]) {
      const endpoint = '/tokens/issue';
      const body = {
        ten: containerId,
        dr: 1,
      };
      const result = await this.query({
        endpoint,
        method: 'POST',
        body,
        useText: true,
      });
      if (result.ok) {
        this.addToken(containerId, result.response);
      }
    }
    return this.tokens[containerId];
  }

  addToken(containerId: string, token: string): void {
    this.tokens[containerId] = token;
  }

  async resolveDependency(name: string): Promise<?string> {
    const url = `${UNPKG_URL}/${name}/package.json`;
    const fetchResult = await fetch(url);
    if (fetchResult.ok) {
      const packageJSON = await fetchResult.json();
      if (packageJSON.version) {
        return (packageJSON.version: string);
      } else {
        return null;
      }
    } else {
      console.log(await fetchResult.text());
      return null;
    }
  }

  async resolveDependencies(
    dependencies: Array<string>,
    oldDependencies: ?Array<Dependency>,
  ): Promise<Array<Dependency>> {
    oldDependencies = oldDependencies || [];
    const packageMap = fromPairs(
      oldDependencies.map(({ name, version }) => [name, version]),
    );
    const result = await Promise.all(
      dependencies.map(async name => {
        if (packageMap[name]) {
          return {
            name,
            version: packageMap[name],
          };
        } else {
          const version = await this.resolveDependency(name);
          if (version) {
            return {
              name,
              version,
            };
          } else {
            return {
              name,
              version: null,
            };
          }
        }
      }),
    );
    return [...CORE_DEPENDENCIES, ...result];
  }

  async ensureDependencies(
    containerId: string,
    dependencies: Array<Dependency>,
  ): Promise<{ ok: boolean }> {
    let token;
    if (this.singeTenantContainer) {
      token = this.token;
    } else {
      token = await this.getToken(containerId);
    }

    const depResult = (await this.query({
      endpoint: '/env/node/modules',
      method: 'POST',
      body: {
        modules: dependencies,
      },
      token,
    }): {
      ok: boolean,
      response: Array<{
        name: string,
        version: string,
        state: 'available' | 'queued' | 'failed',
      }>,
    });
    if (depResult.ok) {
      if (
        depResult.response.every(dependency => dependency.state === 'available')
      ) {
        return {
          ok: true,
        };
      } else {
        console.log('Waiting for dependencies.');
        return new Promise(resolve => {
          setTimeout(() => {
            resolve(this.ensureDependencies(containerId, dependencies));
          }, 1000);
        });
      }
    } else {
      console.log(depResult.response);
      return {
        ok: false,
      };
    }
  }

  async deploy({
    containerId,
    name,
    code,
    context,
    dependencies,
  }: {
    containerId: string,
    name: string,
    code: string,
    context: Array<Context>,
    dependencies: Array<Dependency>,
  }): Promise<{ ok: true, url: string } | { ok: false }> {
    const fullCode = `${RUNNER_WRAPPER(code)}`;

    const depResult = await this.ensureDependencies(containerId, dependencies);
    if (!depResult.ok) {
      return {
        ok: false,
      };
    }

    let endpoint;
    if (this.singleTenantContainer) {
      endpoint = `/webtask/${this
        .singleTenantContainer}/${containerId}_${name}`;
    } else {
      endpoint = `/webtask/${containerId}/${name}`;
    }

    let url;
    if (this.noProxy) {
      if (this.singleTenantContainer) {
        url = `${this.webtaskUrl}/run/${this
          .singleTenantContainer}/${containerId}_${name}`;
      } else {
        url = `${this.webtaskUrl}/run/${containerId}/${name}`;
      }
    } else if (name === 'draft') {
      url = `https://${containerId}.lp.gql.zone/draft/graphql`;
    } else {
      url = `https://${containerId}.lp.gql.zone/graphql`;
    }

    const result = await this.query({
      endpoint,
      method: 'PUT',
      body: {
        code: fullCode,
        secrets: {
          userContext: JSON.stringify(context),
          pb: 1,
          url,
        },
        meta: {
          padId: containerId,
          'wt-node-dependencies': JSON.stringify(
            fromPairs(dependencies.map(({ name, version }) => [name, version])),
          ),
        },
      },
    });

    if (result.ok) {
      return {
        ok: true,
        url,
      };
    } else {
      console.log(result.response);
      return { ok: false };
    }
  }
}

export default WebtaskProvider;
