/**
 * Evaluates the subset of WIQL this app's query builders produce
 * (server/ado/workitems.js, people.js, discovery.js) against the demo
 * organization's work items — for real, not by pattern-matching query text,
 * so a query missing its [System.TeamProject] clause returns every demo
 * project's items exactly as it would against Azure DevOps.
 *
 * Anything outside that subset is a 400 naming the token, so a new query
 * shape fails loudly in demo mode instead of quietly returning nothing.
 */

const KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EVER', 'CONTAINS', 'ORDER', 'BY', 'ASC', 'DESC', 'MODE']);
const DATE_FIELDS = new Set(['System.ChangedDate', 'System.CreatedDate', 'Microsoft.VSTS.Common.ClosedDate', 'Microsoft.VSTS.Common.ResolvedDate']);
const LINK_TYPE_FIELD = 'System.Links.LinkType';
const HIERARCHY_FORWARD = 'System.LinkTypes.Hierarchy-Forward';

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '[') {
      const parts = [];
      while (text[i] === '[') {
        const end = text.indexOf(']', i);
        if (end === -1) throw badRequest(`WIQL: unterminated field reference at ${i}`);
        parts.push(text.slice(i + 1, end));
        i = end + 1;
        if (text[i] === '.' && text[i + 1] === '[') i += 1;
        else break;
      }
      tokens.push(parts.length === 2 ? { t: 'field', prefix: parts[0], name: parts[1] } : { t: 'field', prefix: null, name: parts[0] });
      continue;
    }
    if (ch === "'") {
      let value = '';
      i += 1;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          value += "'";
          i += 2;
        } else if (text[i] === "'") {
          break;
        } else {
          value += text[i];
          i += 1;
        }
      }
      if (text[i] !== "'") throw badRequest('WIQL: unterminated string literal');
      i += 1;
      tokens.push({ t: 'string', v: value });
      continue;
    }
    if (ch === '@') {
      const m = /^@([A-Za-z]+)\s*(?:([+-])\s*(\d+))?/.exec(text.slice(i));
      if (!m || m[1].toLowerCase() !== 'today') throw badRequest(`WIQL: unsupported macro "${(m && m[0]) || '@'}"`);
      tokens.push({ t: 'today', offset: m[2] ? (m[2] === '-' ? -1 : 1) * Number(m[3]) : 0 });
      i += m[0].length;
      continue;
    }
    const op = /^(<>|>=|<=|=|>|<)/.exec(text.slice(i));
    if (op) {
      tokens.push({ t: 'op', v: op[1] });
      i += op[1].length;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ t: ch });
      i += 1;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(text.slice(i));
    if (num) {
      tokens.push({ t: 'number', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (word) {
      const upper = word[0].toUpperCase();
      tokens.push(KEYWORDS.has(upper) ? { t: 'kw', v: upper } : { t: 'word', v: word[0] });
      i += word[0].length;
      continue;
    }
    throw badRequest(`WIQL: unexpected character "${ch}"`);
  }
  return tokens;
}

function parse(text) {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const describe = (tok) => (tok ? tok.v || tok.name || tok.t : 'end of query');
  const isKw = (v) => peek() && peek().t === 'kw' && peek().v === v;
  const expectKw = (v) => {
    if (!isKw(v)) throw badRequest(`WIQL: expected ${v} but found "${describe(peek())}"`);
    pos += 1;
  };

  expectKw('SELECT');
  while (peek() && !isKw('FROM')) pos += 1;
  expectKw('FROM');
  const source = peek();
  if (!source || source.t !== 'word') throw badRequest(`WIQL: unsupported FROM "${describe(source)}"`);
  pos += 1;
  const from = source.v.toLowerCase();
  if (from !== 'workitems' && from !== 'workitemlinks') throw badRequest(`WIQL: unsupported FROM "${source.v}"`);

  function operand() {
    const tok = peek();
    if (!tok) throw badRequest('WIQL: unexpected end of query');
    if (['field', 'string', 'number', 'today'].includes(tok.t)) {
      pos += 1;
      return tok;
    }
    throw badRequest(`WIQL: unsupported token "${describe(tok)}"`);
  }

  function comparison() {
    const left = operand();
    let negate = false;
    if (isKw('NOT')) {
      negate = true;
      pos += 1;
    }
    const tok = peek();
    if (tok && tok.t === 'kw' && tok.v === 'IN') {
      pos += 1;
      if (!peek() || peek().t !== '(') throw badRequest('WIQL: expected ( after IN');
      pos += 1;
      const list = [];
      while (peek() && peek().t !== ')') {
        list.push(operand());
        if (peek() && peek().t === ',') pos += 1;
      }
      pos += 1;
      return { k: 'in', left, list, negate };
    }
    if (tok && tok.t === 'kw' && (tok.v === 'EVER' || tok.v === 'CONTAINS')) {
      pos += 1;
      return { k: tok.v.toLowerCase(), left, right: operand(), negate };
    }
    if (negate) throw badRequest(`WIQL: unsupported NOT before "${describe(tok)}"`);
    if (!tok || tok.t !== 'op') throw badRequest(`WIQL: unsupported operator "${describe(tok)}"`);
    pos += 1;
    return { k: 'cmp', op: tok.v, left, right: operand() };
  }

  function factor() {
    if (isKw('NOT')) {
      pos += 1;
      return { k: 'not', e: factor() };
    }
    if (peek() && peek().t === '(') {
      pos += 1;
      const e = expr();
      if (!peek() || peek().t !== ')') throw badRequest(`WIQL: expected ) but found "${describe(peek())}"`);
      pos += 1;
      return e;
    }
    return comparison();
  }

  function term() {
    let e = factor();
    while (isKw('AND')) {
      pos += 1;
      e = { k: 'and', a: e, b: factor() };
    }
    return e;
  }

  function expr() {
    let e = term();
    while (isKw('OR')) {
      pos += 1;
      e = { k: 'or', a: e, b: term() };
    }
    return e;
  }

  let where = null;
  if (isKw('WHERE')) {
    pos += 1;
    where = expr();
  }
  const order = [];
  if (isKw('ORDER')) {
    pos += 1;
    expectKw('BY');
    while (peek() && peek().t === 'field') {
      const field = peek();
      pos += 1;
      let desc = false;
      if (isKw('ASC') || isKw('DESC')) {
        desc = peek().v === 'DESC';
        pos += 1;
      }
      order.push({ field, desc });
      if (peek() && peek().t === ',') pos += 1;
    }
  }
  if (pos < tokens.length) throw badRequest(`WIQL: unsupported token "${describe(peek())}"`);
  return { from, where, order };
}

function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function evaluate(queryText, { items, today, top } = {}) {
  const q = parse(queryText);
  const todayDate = today || new Date();

  function literal(tok, fieldName) {
    if (tok.t === 'today') {
      const d = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate() + tok.offset);
      return { date: localDate(d) };
    }
    if (tok.t === 'string' && fieldName && DATE_FIELDS.has(fieldName)) {
      if (/[T\s]\d{1,2}:\d{2}/.test(tok.v)) {
        throw badRequest('You cannot supply a time with the date when running a query using date precision.');
      }
      return { date: tok.v.slice(0, 10) };
    }
    return { value: tok.v };
  }

  function fieldValue(tok, ctx) {
    if (tok.name === LINK_TYPE_FIELD) return ctx.linkType;
    const item = tok.prefix && tok.prefix.toLowerCase() === 'target' ? ctx.target : ctx.source;
    if (!item) return undefined;
    if (tok.name === 'System.Id') return item.id;
    return item.fields[tok.name];
  }

  function resolve(tok, ctx, otherField) {
    if (tok.t === 'field') return { field: tok.name, value: fieldValue(tok, ctx) };
    return literal(tok, otherField);
  }

  function identityMatches(identity, text) {
    const s = String(text).toLowerCase();
    const unique = String(identity.uniqueName || '').toLowerCase();
    const display = String(identity.displayName || '').toLowerCase();
    return s === unique || s === display || s === `${display} <${unique}>`;
  }

  function equals(value, lit) {
    if (lit.date !== undefined) {
      if (!value) return false;
      return localDate(new Date(value)) === lit.date;
    }
    const target = lit.value;
    if (value === undefined || value === null || value === '') return target === '' || target === undefined;
    if (typeof value === 'object') return identityMatches(value, target);
    if (typeof value === 'number' || typeof target === 'number') return Number(value) === Number(target);
    return String(value).toLowerCase() === String(target).toLowerCase();
  }

  function compare(value, lit) {
    if (lit.date !== undefined) {
      if (!value) return null;
      const v = localDate(new Date(value));
      return v < lit.date ? -1 : v > lit.date ? 1 : 0;
    }
    if (value === undefined || value === null) return null;
    if (typeof value === 'number' || typeof lit.value === 'number') return Number(value) - Number(lit.value);
    const a = String(value).toLowerCase();
    const b = String(lit.value).toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function test(node, ctx) {
    switch (node.k) {
      case 'and':
        return test(node.a, ctx) && test(node.b, ctx);
      case 'or':
        return test(node.a, ctx) || test(node.b, ctx);
      case 'not':
        return !test(node.e, ctx);
      case 'cmp': {
        const leftField = node.left.t === 'field' ? node.left.name : null;
        const rightField = node.right.t === 'field' ? node.right.name : null;
        const left = resolve(node.left, ctx, rightField);
        const right = resolve(node.right, ctx, leftField);
        // Normalise to "subject op literal", flipping the operator when the
        // field is on the right.
        const flip = { '>': '<', '<': '>', '>=': '<=', '<=': '>=', '=': '=', '<>': '<>' };
        let subject;
        let lit;
        let op = node.op;
        if (leftField || !rightField) {
          subject = leftField ? left.value : left.value !== undefined ? left.value : left.date;
          lit = rightField ? { value: right.value } : right;
        } else {
          subject = right.value;
          lit = left;
          op = flip[op];
        }
        if (op === '=') return equals(subject, lit);
        if (op === '<>') return !equals(subject, lit);
        const c = compare(subject, lit);
        if (c === null) return false;
        if (op === '>') return c > 0;
        if (op === '>=') return c >= 0;
        if (op === '<') return c < 0;
        return c <= 0;
      }
      case 'in': {
        const left = resolve(node.left, ctx, null);
        const hit = node.list.some((tok) => equals(left.value, literal(tok, left.field)));
        return node.negate ? !hit : hit;
      }
      case 'contains': {
        const left = resolve(node.left, ctx, null);
        const needle = String(literal(node.right, null).value || '').toLowerCase();
        const hay = left.value && typeof left.value === 'object' ? `${left.value.displayName} ${left.value.uniqueName}` : String(left.value || '');
        const hit = hay.toLowerCase().includes(needle);
        return node.negate ? !hit : hit;
      }
      case 'ever': {
        const item = node.left.prefix && node.left.prefix.toLowerCase() === 'target' ? ctx.target : ctx.source;
        if (!item) return false;
        const lit = literal(node.right, node.left.name);
        const hit = (item.revisions || [{ fields: item.fields }]).some((r) => equals(r.fields[node.left.name], lit));
        return node.negate ? !hit : hit;
      }
      default:
        throw badRequest('WIQL: unsupported expression');
    }
  }

  const matches = (ctx) => (q.where ? test(q.where, ctx) : true);
  const all = items || [];

  if (q.from === 'workitems') {
    let hits = all.filter((item) => matches({ source: item }));
    for (const { field, desc } of q.order.slice().reverse()) {
      hits = hits.slice().sort((a, b) => {
        const av = field.name === 'System.Id' ? a.id : a.fields[field.name];
        const bv = field.name === 'System.Id' ? b.id : b.fields[field.name];
        const c = av < bv ? -1 : av > bv ? 1 : 0;
        return desc ? -c : c;
      });
    }
    if (top) hits = hits.slice(0, Number(top));
    return { queryType: 'flat', workItems: hits.map((i) => ({ id: i.id, url: `https://dev.azure.com/masar/_apis/wit/workItems/${i.id}` })) };
  }

  const byId = new Map(all.map((i) => [i.id, i]));
  const relations = [];
  for (const source of all) {
    const pairs = [];
    for (const rel of source.relations || []) {
      if (rel.rel !== HIERARCHY_FORWARD) continue;
      const m = /\/workItems\/(\d+)$/i.exec(rel.url || '');
      const target = m && byId.get(Number(m[1]));
      if (!target) continue;
      if (matches({ source, target, linkType: HIERARCHY_FORWARD })) pairs.push(target);
    }
    if (pairs.length === 0) continue;
    relations.push({ rel: null, source: null, target: { id: source.id } });
    for (const target of pairs) relations.push({ rel: HIERARCHY_FORWARD, source: { id: source.id }, target: { id: target.id } });
  }
  return { queryType: 'tree', workItemRelations: relations };
}

module.exports = { evaluate, parse, tokenize };
