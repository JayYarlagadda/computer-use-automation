/**
 * Fabricated member records for the mock back-office.
 *
 * Every value here is invented. The SSN field exists specifically so the
 * redaction path has something regulated-looking to redact in screenshots,
 * logs and artifacts; it is not a real number format anyone is using.
 */

export interface Account {
  kind: 'Savings' | 'Checking' | 'Money Market' | 'Certificate';
  number: string;
  balance: number;
  status: 'Open' | 'Dormant' | 'Frozen';
}

export interface Member {
  memberId: string;
  name: string;
  ssn: string;
  joined: string;
  branch: string;
  /** Restricted members produce a permission denial rather than a record. */
  restricted?: boolean;
  accounts: Account[];
}

export const MEMBERS: Member[] = [
  {
    memberId: '100245',
    name: 'Dana Whitfield',
    ssn: '412-88-0173',
    joined: '2014-03-11',
    branch: 'Riverside',
    accounts: [
      { kind: 'Savings', number: 'SV-0044182', balance: 4182.55, status: 'Open' },
      { kind: 'Checking', number: 'CK-0044183', balance: 912.3, status: 'Open' },
      { kind: 'Certificate', number: 'CD-0044184', balance: 15000.0, status: 'Open' },
    ],
  },
  {
    memberId: '100246',
    name: 'Marcus Bell',
    ssn: '318-55-9920',
    joined: '2019-07-02',
    branch: 'Northgate',
    accounts: [
      { kind: 'Savings', number: 'SV-0051002', balance: 215.0, status: 'Open' },
      { kind: 'Checking', number: 'CK-0051003', balance: 48.17, status: 'Dormant' },
    ],
  },
  {
    memberId: '100247',
    name: 'Priya Raman',
    ssn: '290-41-7734',
    joined: '2011-01-28',
    branch: 'Riverside',
    restricted: true,
    accounts: [{ kind: 'Savings', number: 'SV-0033900', balance: 88214.09, status: 'Open' }],
  },
  {
    memberId: '100248',
    name: 'Alan Ortiz',
    ssn: '551-20-6612',
    joined: '2022-11-19',
    branch: 'Westfield',
    accounts: [
      { kind: 'Savings', number: 'SV-0060771', balance: 0.0, status: 'Dormant' },
    ],
  },
  {
    memberId: '100249',
    name: 'Helen Nakamura',
    ssn: '733-09-4418',
    joined: '2008-05-04',
    branch: 'Northgate',
    accounts: [
      { kind: 'Savings', number: 'SV-0021145', balance: 27311.84, status: 'Open' },
      { kind: 'Money Market', number: 'MM-0021146', balance: 5200.0, status: 'Frozen' },
    ],
  },
];

export function findMember(memberId: string): Member | undefined {
  return MEMBERS.find((m) => m.memberId === memberId.trim());
}

/** The app only accepts a 6-digit member number; anything else is a form error. */
export function isWellFormedMemberId(raw: string): boolean {
  return /^\d{6}$/.test(raw.trim());
}

export function formatCurrency(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
