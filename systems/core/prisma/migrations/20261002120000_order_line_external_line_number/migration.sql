-- Walmart's own orderLine.lineNumber, so ship/cancel stop deriving it from
-- line position (launch checklist 1.8). Nullable and additive: storefront
-- lines never set it, and existing Walmart lines keep the positional fallback.
ALTER TABLE "order_lines" ADD COLUMN "external_line_number" TEXT;
