/**
 * The agent-facing view of a capability.
 *
 * An artifact is written to be reviewed by a person; a calling agent needs a
 * tool definition with a JSON Schema for its arguments. Both are produced from
 * the same `inputs` array rather than maintained side by side, so the thing the
 * agent calls and the thing the reviewer approved cannot drift apart. That is
 * most of the reason the type vocabulary in ./schema.ts is closed and small.
 *
 * The generated description is doing real work. A calling agent decides whether
 * to invoke this capability from the description alone, and the single most
 * useful thing to tell it is which non-success answers are normal -- otherwise
 * it treats "no such member" as a tool failure and retries, which is both
 * useless and, against banking software, not free.
 */

import type { CapabilityArtifact, ParamSpec, ValueType } from './schema.js';

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: false;
}

export interface JsonSchemaProperty {
  type: 'string' | 'integer' | 'number' | 'boolean';
  description: string;
  enum?: string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  format?: string;
  examples?: string[];
}

/** Tool definition shape shared by the Anthropic and OpenAI function-calling APIs. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

const JSON_TYPE: Record<ValueType, JsonSchemaProperty['type']> = {
  string: 'string',
  integer: 'integer',
  number: 'number',
  boolean: 'boolean',
  // Money crosses the wire as a string. A caller that parses "4182.55" into a
  // float has made a choice; a schema that hands them a float has made it for
  // them, and rounding a balance is not a decision this layer should take.
  currency: 'string',
  date: 'string',
  enum: 'string',
};

export function inputsToJsonSchema(inputs: ParamSpec[]): JsonSchemaObject {
  const properties: Record<string, JsonSchemaProperty> = {};

  for (const input of inputs) {
    const property: JsonSchemaProperty = {
      type: JSON_TYPE[input.type],
      description: describeParam(input),
    };

    if (input.type === 'enum' && input.options) property.enum = input.options;
    if (input.type === 'date') property.format = 'date';
    if (input.pattern) property.pattern = input.pattern;
    if (input.minLength !== undefined) property.minLength = input.minLength;
    if (input.maxLength !== undefined) property.maxLength = input.maxLength;
    if (input.example) property.examples = [input.example];

    properties[input.name] = property;
  }

  return {
    type: 'object',
    properties,
    required: inputs.filter((i) => i.required).map((i) => i.name),
    additionalProperties: false,
  };
}

/**
 * Sensitivity is surfaced in the description rather than dropped.
 *
 * The calling agent is the one holding the value, and telling it "this is
 * regulated" is the only lever we have over what it does before the call. It
 * is advisory -- the enforcement is downstream, where the value is redacted out
 * of logs and screenshots regardless of what the caller did.
 */
function describeParam(input: ParamSpec): string {
  const notes: string[] = [input.description];

  if (input.sensitivity === 'restricted') {
    notes.push('Regulated data: do not log or echo this value.');
  }
  if (input.sensitivity === 'secret') {
    notes.push('Credential: supply by reference from a secret store, never inline.');
  }
  if (input.type === 'currency') notes.push('Decimal string, e.g. "1234.56".');

  return notes.join(' ');
}

export function toToolDefinition(artifact: CapabilityArtifact): ToolDefinition {
  return {
    name: artifact.capability.id.replace(/\./g, '_'),
    description: describeCapability(artifact),
    inputSchema: inputsToJsonSchema(artifact.inputs),
  };
}

function describeCapability(a: CapabilityArtifact): string {
  const parts: string[] = [a.capability.description];

  if (a.outputs.length) {
    parts.push(`Returns: ${a.outputs.map((o) => `${o.name} (${o.type}) -- ${o.description}`).join('; ')}.`);
  }

  if (a.outcomes.length) {
    parts.push(
      `Legitimate non-success outcomes, returned as results rather than errors: ` +
        `${a.outcomes.map((o) => `${o.code} (${o.title})`).join('; ')}.`,
    );
  }

  if (a.risk === 'irreversible') {
    parts.push('This capability performs an irreversible action and requires an attended session with operator approval.');
  }
  if (a.approval.state !== 'approved') {
    parts.push(`Approval state: ${a.approval.state}. Unattended invocation is refused until approved.`);
  }

  return parts.join(' ');
}

/** A whole catalog, as an agent would be handed it. */
export function toCatalog(artifacts: CapabilityArtifact[]): ToolDefinition[] {
  return artifacts.map(toToolDefinition);
}
