type ValidationResult = {
  valid: boolean;
  errors: string[];
};

type LocatorLike = {
  mode?: unknown;
  selector?: unknown;
  query?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBooleanOrUndefined(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function validateIntegerRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  errors: string[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    errors.push(`${field} must be an integer between ${min} and ${max}`);
  }
}

function validatePositiveNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  errors: string[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    errors.push(`${field} must be a number between ${min} and ${max}`);
  }
}

function validateStringArray(
  value: unknown,
  field: string,
  errors: string[],
  opts: { minLength?: number; maxLength?: number } = {},
): void {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  if (opts.minLength !== undefined && value.length < opts.minLength) {
    errors.push(`${field} must contain at least ${opts.minLength} item(s)`);
  }
  if (opts.maxLength !== undefined && value.length > opts.maxLength) {
    errors.push(`${field} exceeds maximum of ${opts.maxLength} items`);
  }
  if (!value.every(isNonEmptyString)) {
    errors.push(`${field} must contain non-empty strings`);
  }
}

function validateExtractOptions(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('inputs.extract must be an object');
    return;
  }
  const extract = value as Record<string, unknown>;
  if (!isBooleanOrUndefined(extract.pageInfo)) errors.push('inputs.extract.pageInfo must be a boolean');
  if (!isBooleanOrUndefined(extract.content)) errors.push('inputs.extract.content must be a boolean');
  validateIntegerRange(extract.maxElements, 'inputs.extract.maxElements', 1, 1000, errors);
  validateIntegerRange(extract.maxContentLength, 'inputs.extract.maxContentLength', 1, 50_000, errors);
}

function validateLocator(value: unknown, baseField: string, errors: string[], required = true): void {
  if (value === undefined) {
    if (required) errors.push(`${baseField} is required`);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${baseField} must be an object`);
    return;
  }

  const locator = value as LocatorLike;
  if (locator.mode !== 'selector' && locator.mode !== 'semantic') {
    errors.push(`${baseField}.mode must be selector or semantic`);
    return;
  }

  if (locator.mode === 'selector' && !isNonEmptyString(locator.selector)) {
    errors.push(`${baseField}.selector is required in selector mode`);
  }
  if (locator.mode === 'semantic' && !isNonEmptyString(locator.query)) {
    errors.push(`${baseField}.query is required in semantic mode`);
  }
}

function validateWaitCondition(value: unknown, baseField: string, errors: string[]): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${baseField} must be an object`);
    return;
  }

  const waitFor = value as Record<string, unknown>;
  if (!['selector', 'urlContains', 'stable', 'textIncludes'].includes(String(waitFor.type ?? ''))) {
    errors.push(`${baseField}.type must be selector, urlContains, stable, or textIncludes`);
  }
  if ((waitFor.type === 'selector' || waitFor.type === 'urlContains' || waitFor.type === 'textIncludes')
    && !isNonEmptyString(waitFor.value)) {
    errors.push(`${baseField}.value is required for ${waitFor.type}`);
  }
  validateIntegerRange(waitFor.timeoutMs, `${baseField}.timeoutMs`, 1, 120_000, errors);
}

function validateBatchExtractInputs(inputs: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  validateStringArray(inputs.urls, 'inputs.urls', errors, { minLength: 1, maxLength: 1000 });
  validateExtractOptions(inputs.extract, errors);
  validateIntegerRange(inputs.concurrency, 'inputs.concurrency', 1, 5, errors);
  return { valid: errors.length === 0, errors };
}

function validateMultiTabCompareInputs(inputs: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  validateStringArray(inputs.urls, 'inputs.urls', errors, { minLength: 1, maxLength: 10 });
  validateExtractOptions(inputs.extract, errors);
  validateIntegerRange(inputs.concurrency, 'inputs.concurrency', 1, 5, errors);

  if (inputs.compare !== undefined) {
    if (!inputs.compare || typeof inputs.compare !== 'object' || Array.isArray(inputs.compare)) {
      errors.push('inputs.compare must be an object');
    } else {
      const compare = inputs.compare as Record<string, unknown>;
      if (compare.fields !== undefined) {
        if (!Array.isArray(compare.fields) || compare.fields.length === 0) {
          errors.push('inputs.compare.fields must be a non-empty array');
        } else {
          const allowed = new Set(['title', 'elementCount', 'topSections']);
          if (!compare.fields.every((field) => allowed.has(String(field)))) {
            errors.push('inputs.compare.fields contains unsupported values');
          }
        }
      }
      validateIntegerRange(compare.topSections, 'inputs.compare.topSections', 1, 20, errors);
      validatePositiveNumber(compare.numericTolerance, 'inputs.compare.numericTolerance', 0, 1_000_000, errors);
    }
  }

  const extract = inputs.extract as Record<string, unknown> | undefined;
  const compare = inputs.compare as Record<string, unknown> | undefined;
  const fields = Array.isArray(compare?.fields) ? compare!.fields.map(String) : ['title', 'elementCount', 'topSections'];
  const needsPageInfo = fields.includes('title') || fields.includes('elementCount');
  const needsContent = fields.includes('topSections');
  if (extract?.pageInfo === false && needsPageInfo) {
    errors.push('inputs.extract.pageInfo=false is incompatible with compare.fields including title/elementCount');
  }
  if (extract?.content === false && needsContent) {
    errors.push('inputs.extract.content=false is incompatible with compare.fields including topSections');
  }

  return { valid: errors.length === 0, errors };
}

function validateLoginKeepSessionInputs(inputs: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  if (!isNonEmptyString(inputs.startUrl)) {
    errors.push('inputs.startUrl is required');
  }

  const credentials = inputs.credentials;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    errors.push('inputs.credentials is required');
  } else {
    const rec = credentials as Record<string, unknown>;
    if (!isNonEmptyString(rec.username)) errors.push('inputs.credentials.username is required');
    if (!isNonEmptyString(rec.password)) errors.push('inputs.credentials.password is required');
  }

  const fields = inputs.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    errors.push('inputs.fields is required');
  } else {
    const rec = fields as Record<string, unknown>;
    if (rec.mode !== 'selector' && rec.mode !== 'semantic') {
      errors.push('inputs.fields.mode must be selector or semantic');
    } else if (rec.mode === 'selector') {
      if (!isNonEmptyString(rec.usernameSelector)) errors.push('inputs.fields.usernameSelector is required in selector mode');
      if (!isNonEmptyString(rec.passwordSelector)) errors.push('inputs.fields.passwordSelector is required in selector mode');
      if (rec.submitSelector !== undefined && !isNonEmptyString(rec.submitSelector)) {
        errors.push('inputs.fields.submitSelector must be a non-empty string');
      }
    } else {
      if (!isNonEmptyString(rec.usernameQuery)) errors.push('inputs.fields.usernameQuery is required in semantic mode');
      if (!isNonEmptyString(rec.passwordQuery)) errors.push('inputs.fields.passwordQuery is required in semantic mode');
      if (rec.submitQuery !== undefined && !isNonEmptyString(rec.submitQuery)) {
        errors.push('inputs.fields.submitQuery must be a non-empty string');
      }
    }
  }

  if (inputs.successIndicator !== undefined) {
    validateWaitCondition(inputs.successIndicator, 'inputs.successIndicator', errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateSearchExtractInputs(inputs: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  if (!isNonEmptyString(inputs.startUrl)) errors.push('inputs.startUrl is required');
  if (!isNonEmptyString(inputs.query)) errors.push('inputs.query is required');
  validateLocator(inputs.searchField, 'inputs.searchField', errors, true);
  validateLocator(inputs.submit, 'inputs.submit', errors, false);
  validateLocator(inputs.openResult, 'inputs.openResult', errors, false);
  validateWaitCondition(inputs.waitForResults, 'inputs.waitForResults', errors);
  validateExtractOptions(inputs.extract, errors);
  return { valid: errors.length === 0, errors };
}

function validatePaginatedExtractInputs(inputs: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  if (!isNonEmptyString(inputs.startUrl)) errors.push('inputs.startUrl is required');
  if (!inputs.pagination || typeof inputs.pagination !== 'object' || Array.isArray(inputs.pagination)) {
    errors.push('inputs.pagination is required');
  } else {
    const pagination = inputs.pagination as Record<string, unknown>;
    validateLocator(pagination.next, 'inputs.pagination.next', errors, true);
    validateIntegerRange(pagination.maxPages, 'inputs.pagination.maxPages', 1, 50, errors);
    validateWaitCondition(pagination.waitFor, 'inputs.pagination.waitFor', errors);
  }
  validateExtractOptions(inputs.extract, errors);
  return { valid: errors.length === 0, errors };
}

function validateSubmitAndVerifyInputs(inputs: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  if (!isNonEmptyString(inputs.startUrl)) errors.push('inputs.startUrl is required');

  if (!Array.isArray(inputs.fields) || inputs.fields.length === 0) {
    errors.push('inputs.fields must be a non-empty array');
  } else {
    inputs.fields.forEach((field, index) => {
      const baseField = `inputs.fields[${index}]`;
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        errors.push(`${baseField} must be an object`);
        return;
      }
      const rec = field as Record<string, unknown>;
      if (!isNonEmptyString(rec.name)) errors.push(`${baseField}.name is required`);
      if (!isNonEmptyString(rec.value)) errors.push(`${baseField}.value is required`);
      validateLocator(rec.locator, `${baseField}.locator`, errors, true);
    });
  }

  validateLocator(inputs.submit, 'inputs.submit', errors, false);
  validateWaitCondition(inputs.successIndicator, 'inputs.successIndicator', errors);
  validateExtractOptions(inputs.extract, errors);
  return { valid: errors.length === 0, errors };
}

const validators: Record<string, (inputs: Record<string, unknown>) => ValidationResult> = {
  batch_extract_pages: validateBatchExtractInputs,
  multi_tab_compare: validateMultiTabCompareInputs,
  login_keep_session: validateLoginKeepSessionInputs,
  search_extract: validateSearchExtractInputs,
  paginated_extract: validatePaginatedExtractInputs,
  submit_and_verify: validateSubmitAndVerifyInputs,
};

export function validateTemplateInputs(
  templateId: string | undefined,
  inputs?: Record<string, unknown>,
): ValidationResult {
  if (!templateId) {
    return { valid: false, errors: ['templateId is required'] };
  }
  const validator = validators[templateId];
  if (!validator) {
    return { valid: true, errors: [] };
  }
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return { valid: false, errors: ['inputs must be an object'] };
  }
  return validator(inputs);
}

export function hasValidTemplateInputs(
  templateId: string | undefined,
  inputs?: Record<string, unknown>,
): boolean {
  return validateTemplateInputs(templateId, inputs).valid;
}
