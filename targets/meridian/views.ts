/**
 * Views for the mock back-office.
 *
 * The markup here is bad on purpose. It is a reconstruction of what
 * server-rendered enterprise banking software actually looks like:
 *
 *   - a real <frameset>, so every element lives at a frame path
 *   - tables used for layout, with <font> and bgcolor attributes
 *   - no id, no class, no data-testid on any control
 *   - form fields with NO <label for> association: the "label" is just the
 *     table cell to the left
 *
 * That last point is the important one. Buttons and links get an accessible
 * name from their text, so role+name targeting works on them. Inputs get no
 * accessible name at all -- which is exactly the situation where the
 * anchor-relative rung of the locator ladder has to do the work. If this app
 * were nicely marked up, the locator strategy would never be tested.
 */

import type { TenantConfig } from './tenants.js';
import { formatCurrency, type Member } from './data/members.js';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function chrome(t: TenantConfig, title: string, body: string): string {
  return `<html>
<head><title>${esc(t.product)} - ${esc(title)}</title></head>
<body bgcolor="#f4f4f0" style="font-family:Verdana,Geneva,sans-serif;font-size:12px;margin:0">
<table width="100%" cellpadding="6" cellspacing="0" border="0" bgcolor="${t.accent}">
  <tr><td><font color="#ffffff" size="3"><b>${esc(t.institution)}</b></font>
      <font color="#c8d4e4" size="1">&nbsp;&nbsp;${esc(t.product)} v${esc(t.productVersion)}</font></td></tr>
</table>
<table width="100%" cellpadding="10" cellspacing="0" border="0"><tr><td>${body}</td></tr></table>
</body></html>`;
}

export function loginPage(t: TenantConfig, error?: string): string {
  return chrome(
    t,
    'Sign On',
    `<table cellpadding="8" cellspacing="0" border="1" bordercolor="#c0c0c0" bgcolor="#ffffff">
  <tr><td colspan="2" bgcolor="#e8e8e0"><b>Operator Sign On</b></td></tr>
  ${error ? `<tr><td colspan="2"><font color="#a00000"><b>${esc(error)}</b></font></td></tr>` : ''}
  <form method="POST" action="/login">
  <tr><td align="right">Operator ID</td><td><input type="text" name="user" size="24"></td></tr>
  <tr><td align="right">Password</td><td><input type="password" name="pass" size="24"></td></tr>
  <tr><td></td><td><input type="submit" value="Sign On"></td></tr>
  </form>
</table>
<br><font size="1" color="#606060">Demo system. Use operator / demo1234.</font>`,
  );
}

/** The frameset itself. Every subsequent element sits inside a named frame. */
export function appFrameset(t: TenantConfig): string {
  return `<html>
<head><title>${esc(t.product)}</title></head>
<frameset cols="180,*" border="1">
  <frame name="navFrame" src="/nav">
  <frame name="contentFrame" src="/search">
</frameset>
</html>`;
}

export function navFrame(t: TenantConfig): string {
  return `<html><body bgcolor="#e8e8e0" style="font-family:Verdana,sans-serif;font-size:11px;margin:0">
<table width="100%" cellpadding="6" cellspacing="0" border="0">
  <tr><td bgcolor="#d0d0c8"><b>Servicing</b></td></tr>
  <tr><td><a href="/search" target="contentFrame">${esc(t.labels.searchScreenTitle)}</a></td></tr>
  <tr><td><a href="/transactions" target="contentFrame">Transaction History</a></td></tr>
  <tr><td><a href="/admin" target="contentFrame">Administration</a></td></tr>
  <tr><td><a href="/logout" target="_top">Sign Off</a></td></tr>
</table></body></html>`;
}

/**
 * Member search. Note the input has no label association -- "Member ID" is
 * just the cell next to it.
 */
export function searchScreen(t: TenantConfig, opts: { error?: string; notFound?: string } = {}): string {
  const banner = opts.error
    ? `<tr><td colspan="2"><font color="#a00000"><b>${esc(opts.error)}</b></font></td></tr>`
    : opts.notFound
      ? `<tr><td colspan="2"><font color="#8a6d00"><b>${esc(opts.notFound)}</b></font></td></tr>`
      : '';

  return chrome(
    t,
    t.labels.searchScreenTitle,
    `<table cellpadding="8" cellspacing="0" border="1" bordercolor="#c0c0c0" bgcolor="#ffffff">
  <tr><td colspan="2" bgcolor="#e8e8e0"><b>${esc(t.labels.searchScreenTitle)}</b></td></tr>
  ${banner}
  <form method="POST" action="/search">
  <tr><td align="right">${esc(t.labels.memberIdField)}</td><td><input type="text" name="memberId" size="18" maxlength="12"></td></tr>
  <tr><td align="right">Branch</td><td>
    <select name="branch"><option value="">All Branches</option><option>Riverside</option><option>Northgate</option><option>Westfield</option></select>
  </td></tr>
  <tr><td></td><td><input type="submit" value="${esc(t.labels.searchButton)}">&nbsp;<input type="reset" value="Clear"></td></tr>
  </form>
</table>
<br><font size="1" color="#606060">Enter the 6-digit member number.</font>`,
  );
}

export function memberScreen(t: TenantConfig, m: Member): string {
  const rows = m.accounts
    .map(
      (a) => `<tr>
    <td>${esc(a.kind)}</td>
    <td><font face="Courier New">${esc(a.number)}</font></td>
    <td align="right"><font face="Courier New">${esc(formatCurrency(a.balance))}</font></td>
    <td>${esc(a.status)}</td>
  </tr>`,
    )
    .join('\n');

  return chrome(
    t,
    'Member Detail',
    `<table cellpadding="6" cellspacing="0" border="1" bordercolor="#c0c0c0" bgcolor="#ffffff">
  <tr><td colspan="4" bgcolor="#e8e8e0"><b>Member Detail</b></td></tr>
  <tr><td align="right">Member ID</td><td><b>${esc(m.memberId)}</b></td>
      <td align="right">Name</td><td><b>${esc(m.name)}</b></td></tr>
  <tr><td align="right">SSN</td><td>${esc(m.ssn)}</td>
      <td align="right">Joined</td><td>${esc(m.joined)}</td></tr>
  <tr><td align="right">Branch</td><td>${esc(m.branch)}</td><td align="right">Status</td><td>Active</td></tr>
</table>
<br>
<table cellpadding="6" cellspacing="0" border="1" bordercolor="#c0c0c0" bgcolor="#ffffff">
  <tr bgcolor="#e8e8e0"><td colspan="4"><b>${esc(t.labels.accountsHeading)}</b></td></tr>
  <tr bgcolor="#f0f0e8"><td><b>Type</b></td><td><b>Account No.</b></td><td align="right"><b>${esc(t.labels.balanceColumn)}</b></td><td><b>Status</b></td></tr>
  ${rows}
</table>
<br>
<a href="/member/${esc(m.memberId)}/adjust">Post Balance Adjustment</a>
&nbsp;|&nbsp;<a href="/search">Back to ${esc(t.labels.searchScreenTitle)}</a>`,
  );
}

/**
 * An irreversible action. Posting a balance adjustment moves money; the policy
 * layer is expected to refuse to do this unattended and escalate instead.
 */
export function adjustScreen(t: TenantConfig, m: Member): string {
  return chrome(
    t,
    'Post Adjustment',
    `<table cellpadding="8" cellspacing="0" border="1" bordercolor="#c0c0c0" bgcolor="#ffffff">
  <tr><td colspan="2" bgcolor="#e8e8e0"><b>Post Balance Adjustment &mdash; ${esc(m.name)}</b></td></tr>
  <form method="POST" action="/member/${esc(m.memberId)}/adjust">
  <tr><td align="right">Account</td><td><select name="account">${m.accounts
    .map((a) => `<option value="${esc(a.number)}">${esc(a.kind)} ${esc(a.number)}</option>`)
    .join('')}</select></td></tr>
  <tr><td align="right">Amount</td><td><input type="text" name="amount" size="12"></td></tr>
  <tr><td align="right">Memo</td><td><input type="text" name="memo" size="30"></td></tr>
  <tr><td></td><td><input type="submit" value="Post Adjustment"></td></tr>
  </form>
</table>
<br><font size="1" color="#a00000">Adjustments post immediately and cannot be reversed from this screen.</font>`,
  );
}

export function permissionDeniedScreen(t: TenantConfig, memberId: string): string {
  return chrome(
    t,
    'Access Denied',
    `<table cellpadding="10" cellspacing="0" border="1" bordercolor="#a00000" bgcolor="#fff4f4">
  <tr><td bgcolor="#a00000"><font color="#ffffff"><b>Access Denied</b></font></td></tr>
  <tr><td>Your operator profile is not authorised to view member ${esc(memberId)}.<br>
  Contact the branch administrator to request elevated entitlements.<br><br>
  <font size="1">Reference: ENT-4021</font></td></tr>
</table>`,
  );
}

export function appErrorScreen(t: TenantConfig): string {
  return chrome(
    t,
    'System Error',
    `<table cellpadding="10" cellspacing="0" border="1" bordercolor="#a00000" bgcolor="#fff4f4">
  <tr><td bgcolor="#a00000"><font color="#ffffff"><b>Unexpected System Error</b></font></td></tr>
  <tr><td>The servicing host did not respond.<br><font size="1">Reference: SYS-500</font></td></tr>
</table>`,
  );
}

/**
 * A surprise interstitial. Tenant B shows one routinely after sign-on; it can
 * also be injected as a fault to test that replay dismisses known
 * interstitials rather than blindly clicking through them.
 */
export function interstitialScreen(t: TenantConfig, next: string): string {
  return chrome(
    t,
    'Notice',
    `<table cellpadding="10" cellspacing="0" border="1" bordercolor="#8a6d00" bgcolor="#fffdf0">
  <tr><td bgcolor="#8a6d00"><font color="#ffffff"><b>System Notice</b></font></td></tr>
  <tr><td>Scheduled maintenance will occur this weekend. Servicing screens may be
  briefly unavailable.<br><br>
  <a href="${esc(next)}">Acknowledge and Continue</a></td></tr>
</table>`,
  );
}

export function transactionsScreen(t: TenantConfig): string {
  return chrome(t, 'Transaction History', `<b>Transaction History</b><br><br>Select a member first.`);
}

export function adminScreen(t: TenantConfig): string {
  return chrome(t, 'Administration', `<b>Administration</b><br><br>Restricted area.`);
}
