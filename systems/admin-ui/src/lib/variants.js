export function generateVariants({ sku_prefix, price, attribute_key, values }) {
  return (values || [])
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0)
    .map((v) => ({
      sku: `${sku_prefix}${v.toUpperCase()}`,
      price: Number(price),
      attributes: { [attribute_key]: v },
    }))
}
