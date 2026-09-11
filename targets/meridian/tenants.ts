/**
 * Two tenants running the *same vendor product*, configured differently.
 *
 * This is the stand-in for the real environment described in the brief: many
 * institutions run one vendor's core banking software, each with their own
 * branding, wording and minor screen differences. Nothing about the flow
 * changes between tenants -- only labels, button text, chrome, and whether an
 * interstitial is enabled.
 *
 * It exists to test one specific claim: that a capability recorded against
 * tenant A can be replayed against tenant B via a small override, rather than
 * being re-recorded.
 */

export interface TenantConfig {
  id: string;
  institution: string;
  product: string;
  productVersion: string;
  /** Accent colour, purely cosmetic -- but it changes the screenshots. */
  accent: string;
  labels: {
    memberIdField: string;
    searchButton: string;
    searchScreenTitle: string;
    accountsHeading: string;
    balanceColumn: string;
  };
  /** Tenant B shows a "notice" interstitial after login, tenant A does not. */
  loginInterstitial: boolean;
}

export const TENANTS: Record<string, TenantConfig> = {
  a: {
    id: 'a',
    institution: 'Meridian Credit Union',
    product: 'CoreBank Servicing',
    productVersion: '7.2.11',
    accent: '#1c3f6e',
    labels: {
      memberIdField: 'Member ID',
      searchButton: 'Search',
      searchScreenTitle: 'Member Search',
      accountsHeading: 'Share Accounts',
      balanceColumn: 'Current Balance',
    },
    loginInterstitial: false,
  },
  b: {
    id: 'b',
    institution: 'Summit Federal CU',
    product: 'CoreBank Servicing',
    productVersion: '7.4.03',
    accent: '#6e1c2f',
    labels: {
      // Same field, different wording -- the thing a naive recorded selector
      // breaks on, and the thing a tenant override is supposed to absorb.
      memberIdField: 'Member No.',
      searchButton: 'Find Member',
      searchScreenTitle: 'Locate Member',
      accountsHeading: 'Deposit Accounts',
      balanceColumn: 'Balance',
    },
    loginInterstitial: true,
  },
};

export function tenantFor(id: string | undefined): TenantConfig {
  return TENANTS[id ?? 'a'] ?? TENANTS.a!;
}
