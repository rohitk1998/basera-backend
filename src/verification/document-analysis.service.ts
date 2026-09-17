import { Injectable } from '@nestjs/common';
import { detectSignatureMimeType } from '../common/file-signature.util';

// A near-empty file cannot plausibly be a real scanned document/photo —
// below this size we consider it unreadable rather than attempt any
// further analysis.
const MIN_READABLE_BYTES = 1024; // 1KB

// Below this size a file is technically readable but implausibly small
// for a genuine government ID scan/photo — flagged as a warning, not a
// hard error.
const SMALL_FILE_WARNING_BYTES = 15 * 1024; // 15KB

export interface DocumentAnalysisResult {
  documentType: string;
  isReadable: boolean;
  requiredFieldsPresent: boolean;
  warnings: string[];
  errors: string[];
  confidence: number;
}

/**
 * Structural/quality analysis of an uploaded verification document.
 *
 * This is a DETERMINISTIC MOCK: it inspects the real bytes of the file
 * (size, actual magic-number signature vs the claimed mimetype) and
 * produces genuine structural/quality signals, but it does NOT perform
 * real OCR or ID-verification — it never extracts or exposes actual
 * PAN numbers, aadhaar numbers, or account numbers, and it never claims
 * to have read field values out of a PDF or image it cannot actually
 * parse.
 *
 * A real provider — HyperVerge, Signzy, or Setu (see the TODOs already
 * in src/mocks/mocks.service.ts for the same providers) — would plug in
 * behind this exact interface: swap this class's analyze() body for a
 * call to that provider's document/OCR API, keep returning the same
 * DocumentAnalysisResult shape, and no caller needs to change.
 */
@Injectable()
export class DocumentAnalysisService {
  async analyze(
    buffer: Buffer,
    mimetype: string,
    verificationType: string,
    documentSubtype?: string,
  ): Promise<DocumentAnalysisResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    const documentType = documentSubtype ?? verificationType;

    const size = buffer?.length ?? 0;
    const isReadable = size >= MIN_READABLE_BYTES;

    if (!isReadable) {
      errors.push(
        `File is only ${size} bytes — too small to be a real scanned document or photo.`,
      );
    } else if (size < SMALL_FILE_WARNING_BYTES) {
      warnings.push(
        'File is unusually small for a government ID scan — verify the full document was captured.',
      );
    }

    const detectedSignature = detectSignatureMimeType(buffer);
    if (!detectedSignature) {
      errors.push('File signature does not match any supported document format (JPEG/PNG/WebP/PDF).');
    } else if (detectedSignature !== mimetype) {
      errors.push(
        `File signature does not match declared type (declared "${mimetype}", detected "${detectedSignature}").`,
      );
    }

    // No real OCR/ID-extraction happens here — this mock cannot actually
    // read field values out of the document, so it never claims to. A
    // PDF's or image's textual content is opaque to us at this layer;
    // requiredFieldsPresent is only ever true once a real provider is
    // wired in behind this same interface.
    let requiredFieldsPresent = false;
    if (errors.length > 0) {
      requiredFieldsPresent = false;
    } else {
      warnings.push(
        'Automated field extraction is not available in this environment — required fields could not be assessed and must be confirmed by manual review.',
      );
    }

    // Confidence is a coarse structural signal only (readability +
    // signature match), not a claim about the document's authenticity or
    // content — a real provider's confidence score would replace this.
    let confidence = 0;
    if (isReadable) confidence += 0.5;
    if (detectedSignature && detectedSignature === mimetype) confidence += 0.5;
    if (errors.length > 0) confidence = 0;

    return {
      documentType,
      isReadable,
      requiredFieldsPresent,
      warnings,
      errors,
      confidence,
    };
  }
}
