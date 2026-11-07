// PREPARATION ONLY. No OCR, filesystem reads, reference values in diagnostics or production imports.
export const STATES = Object.freeze(['known', 'not_printed', 'illegible', 'not_applicable', 'not_yet_verified']);
export const POLICY = Object.freeze({
  id: 'proposed-new-evaluation-eligibility-1',
  approval: 'pending_owner_approval',
  legacyAssignmentMinimum: null, // The historical 80% rule is not a new-evaluation rule.
  unknownReferenceCredit: false,
  engineFailureRemainsInEligibleDenominator: true,
});
const isInt = Number.isSafeInteger;
const known = field => field?.state === 'known';
const payloadKeys = ['value', 'value_cents', 'verified_absent', 'quantity', 'unit_of_measure'];
const evidenceKinds = new Set(['printed', 'independent_user_verification', 'verified_absence']);
const rational = q => !!q && isInt(q.numerator) && isInt(q.denominator) && q.denominator > 0;
const sha = s => typeof s === 'string' && /^[a-f0-9]{64}$/i.test(s);
const stringFields = /\.(receipt_id|partition|merchant_layout_group_id|currency|description|row_kind|inclusion_mode|scope|financial_role|kind|application_stage|label|tax_treatment|discount_treatment|unit_of_measure)$/;
const booleanFields = /\.(all_product_rows_accounted_for|all_returns_and_adjustments_accounted_for|all_discounts_accounted_for|all_charges_and_taxes_accounted_for|inventory_complete|already_reflected_in_full_line_amounts|already_included_in_full_line_amounts|already_reflected_in_printed_payable_total|discriminates_product_from_neighbours|primary_comparison)$/;

// Return technical paths/codes only. Never include rejected values in errors.
export function validateReference(reference, { requireCompletedIdentity = false } = {}) {
  const errors = [];
  const error = (path, code) => errors.push({ path, code });
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
    return { valid: false, errors: [{ path: '$', code: 'object_required' }] };
  }
  const walk = (object, path) => {
    if (!object || typeof object !== 'object') return;
    if ('state' in object) {
      if (!STATES.includes(object.state)) error(path, 'invalid_reference_state');
      const payloads = payloadKeys.filter(key => Object.hasOwn(object, key));
      if (!payloads.length) error(path, 'state_requires_payload');
      if (object.state !== 'known' && payloads.some(key => object[key] != null && typeof object[key]?.state !== 'string')) {
        error(path, 'unknown_state_must_not_carry_value');
      }
      if (object.state === 'known') {
        const values = payloads.filter(key => typeof object[key]?.state !== 'string');
        if (!values.length || values.some(key => object[key] == null)) error(path, 'known_requires_value');
        if (!object.evidence || !evidenceKinds.has(object.evidence.kind) || typeof object.evidence.location !== 'string' || !object.evidence.location.trim()) error(path, 'known_requires_independent_evidence');
        if ('value_cents' in object && !isInt(object.value_cents)) error(path, 'money_must_be_safe_integer_cents');
        if ('value' in object && stringFields.test(path) && (typeof object.value !== 'string' || !object.value.trim())) error(path, 'nonempty_string_required');
        if ('value' in object && booleanFields.test(path) && typeof object.value !== 'boolean') error(path, 'boolean_required');
        if (path.endsWith('.quantity') && 'value' in object && !rational(object.value)) error(path, 'quantity_requires_exact_rational');
        if ('quantity' in object && (!rational(object.quantity) || object.quantity.numerator <= 0 || typeof object.unit_of_measure !== 'string' || !object.unit_of_measure)) error(path, 'basis_requires_positive_exact_quantity_and_unit');
        if (path.endsWith('rate_basis_points') && !isInt(object.value)) error(path, 'rate_requires_integer_basis_points');
        if (path.endsWith('.inclusion_mode') && !['included', 'added', 'mixed'].includes(object.value)) error(path, 'invalid_gst_inclusion_mode');
        if (path.endsWith('.row_kind') && !['purchase', 'return'].includes(object.value)) error(path, 'invalid_product_row_kind');
        if (path.endsWith('.scope') && !['item', 'receipt'].includes(object.value)) error(path, 'invalid_discount_scope');
      }
      if (requireCompletedIdentity && object.state !== 'not_yet_verified' && (!object.evidence || !evidenceKinds.has(object.evidence.kind) || typeof object.evidence.location !== 'string' || !object.evidence.location.trim())) error(path, 'verified_state_requires_evidence');
      if (object.state === 'not_printed' && (!object.evidence || object.evidence.kind !== 'verified_absence' || typeof object.evidence.location !== 'string' || !object.evidence.location.trim())) error(path, 'absence_requires_absence_evidence');
    }
    for (const [key, value] of Object.entries(object)) walk(value, `${path}.${key}`);
  };
  walk(reference, '$');
  for (const key of ['annotation', 'inventory_verification', 'products', 'discounts', 'returns_and_adjustments', 'charges', 'gst', 'printed_payable_total']) {
    if (reference[key] == null) error(`$.${key}`, 'required_structure_missing');
  }
  for (const key of ['products', 'discounts', 'returns_and_adjustments', 'charges']) if (!Array.isArray(reference[key])) error(`$.${key}`, 'collection_must_be_array');
  if (reference.annotation?.written_independently_of_ocr === false) error('$.annotation', 'prediction_derived_reference_forbidden');
  const ids = new Set();
  for (const [i, product] of (Array.isArray(reference.products) ? reference.products : []).entries()) {
    if (!product || typeof product !== 'object') { error(`$.products.${i}`, 'product_object_required'); continue; }
    for (const field of ['description', 'row_kind', 'quantity', 'unit_price', 'full_line_amount']) {
      if (!product[field] || !STATES.includes(product[field].state)) error(`$.products.${i}.${field}`, 'required_product_field_missing');
    }
    if (product.reference_row_id && ids.has(product.reference_row_id)) error(`$.products.${i}`, 'duplicate_reference_row_id');
    ids.add(product.reference_row_id);
    if (requireCompletedIdentity && !product.reference_row_id) error(`$.products.${i}`, 'reference_row_id_required');
  }
  if (requireCompletedIdentity) {
    if (reference.annotation?.written_independently_of_ocr !== true) error('$.annotation', 'independence_not_verified');
    for (const field of ['receipt_id', 'partition', 'merchant_layout_group_id']) {
      if (!known(reference.annotation?.[field])) error(`$.annotation.${field}`, 'identity_not_verified');
    }
  }
  const extension = reference.preparation_extension;
  if (extension) {
    const imageHash = extension.source?.image_sha256;
    if (imageHash != null && !sha(imageHash)) error('$.preparation_extension.source', 'invalid_image_sha256');
    for (const [i, annotation] of (extension.association_annotations ?? []).entries()) {
      const anchor = annotation.original_source_anchor;
      if (known(anchor)) {
        if (!sha(anchor.value?.image_sha256) || anchor.value.image_sha256 !== imageHash) error(`$.preparation_extension.association_annotations.${i}`, 'anchor_image_identity_mismatch');
        const boxes = anchor.value?.regions;
        if (!Array.isArray(boxes) || !boxes.length || boxes.some(b => !Array.isArray(b) || b.length !== 4 || b.some(v => !Number.isFinite(v) || v < 0 || v > 1) || b[2] <= b[0] || b[3] <= b[1])) error(`$.preparation_extension.association_annotations.${i}`, 'normalised_source_region_required');
        if (!annotation.reference_row_id || !ids.has(annotation.reference_row_id)) error(`$.preparation_extension.association_annotations.${i}`, 'anchor_reference_row_missing');
        if (annotation.independently_written_before_predictions !== true) error(`$.preparation_extension.association_annotations.${i}`, 'anchor_independence_unverified');
      }
    }
  }
  return { valid: errors.length === 0, errors };
}


