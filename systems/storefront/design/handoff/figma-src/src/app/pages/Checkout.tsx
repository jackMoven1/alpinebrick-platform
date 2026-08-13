import { useState } from "react";
import { Link } from "react-router";
import { ChevronRight, Lock, Check, ShoppingBag, Trash2, ArrowLeft } from "lucide-react";
import { useCart } from "../context/CartContext";

type Step = "cart" | "shipping" | "payment" | "confirmation";

const SHIPPING_OPTIONS = [
  { id: "standard", label: "Standard Shipping", time: "5–7 Business Days", price: 0, threshold: 75 },
  { id: "express", label: "Express Shipping", time: "2–3 Business Days", price: 14.99 },
  { id: "overnight", label: "Overnight", time: "Next Business Day", price: 29.99 },
];

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

function StepIndicator({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "cart", label: "Cart" },
    { key: "shipping", label: "Shipping" },
    { key: "payment", label: "Payment" },
    { key: "confirmation", label: "Confirm" },
  ];
  const currentIdx = steps.findIndex((s) => s.key === current);

  return (
    <div className="flex items-center gap-0">
      {steps.map((step, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <div key={step.key} className="flex items-center">
            <div className="flex flex-col items-center">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black border-2 transition-all ${
                done ? "bg-primary border-primary text-primary-foreground" :
                active ? "border-primary text-primary bg-background" :
                "border-border text-muted-foreground bg-background"
              }`}>
                {done ? <Check size={14} /> : i + 1}
              </div>
              <span className={`text-[10px] uppercase tracking-widest mt-1.5 font-bold hidden sm:block ${
                active ? "text-primary" : done ? "text-foreground" : "text-muted-foreground"
              }`}>
                {step.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={`w-12 sm:w-20 h-px mx-1 mb-5 transition-colors ${done ? "bg-primary" : "bg-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Checkout() {
  const { items } = useCart();
  const [step, setStep] = useState<Step>("cart");
  const [quantities, setQuantities] = useState<Record<number, number>>(
    Object.fromEntries(items.map((i) => [i.id, i.quantity]))
  );
  const [selectedShipping, setSelectedShipping] = useState("standard");

  // Shipping form
  const [ship, setShip] = useState({
    firstName: "", lastName: "", email: "", phone: "",
    address: "", apt: "", city: "", state: "CO", zip: "", country: "United States",
  });

  // Payment form
  const [pay, setPay] = useState({
    nameOnCard: "", cardNumber: "", expiry: "", cvv: "", sameAsShipping: true,
    billingAddress: "", billingCity: "", billingState: "CO", billingZip: "",
  });

  const [promoCode, setPromoCode] = useState("");
  const [promoApplied, setPromoApplied] = useState(false);
  const [promoError, setPromoError] = useState(false);

  const cartItems = items.map((item) => ({
    ...item,
    quantity: quantities[item.id] ?? item.quantity,
  })).filter((i) => i.quantity > 0);

  const subtotal = cartItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const shippingOpt = SHIPPING_OPTIONS.find((o) => o.id === selectedShipping)!;
  const shippingCost = selectedShipping === "standard" && subtotal >= 75 ? 0 : shippingOpt.price;
  const discount = promoApplied ? subtotal * 0.1 : 0;
  const tax = (subtotal - discount) * 0.07;
  const total = subtotal - discount + shippingCost + tax;

  function applyPromo() {
    if (promoCode.toUpperCase() === "ALPINE10") {
      setPromoApplied(true);
      setPromoError(false);
    } else {
      setPromoError(true);
      setPromoApplied(false);
    }
  }

  function updateQty(id: number, qty: number) {
    setQuantities((prev) => ({ ...prev, [id]: Math.max(0, qty) }));
  }

  function formatCard(val: string) {
    return val.replace(/\D/g, "").slice(0, 16).replace(/(.{4})/g, "$1 ").trim();
  }

  function formatExpiry(val: string) {
    const digits = val.replace(/\D/g, "").slice(0, 4);
    return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
  }

  const inputCls = "w-full bg-secondary border border-border text-foreground placeholder:text-muted-foreground px-4 py-3 text-sm outline-none focus:border-primary transition-colors";
  const labelCls = "text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-2";

  // ── Order summary sidebar ──
  const OrderSummary = () => (
    <div className="border border-border p-6 sticky top-24">
      <h3 className="font-black uppercase text-lg mb-5" style={{ fontFamily: "var(--font-display)" }}>
        Order Summary
      </h3>

      {cartItems.length === 0 ? (
        <p className="text-muted-foreground text-sm">Your cart is empty.</p>
      ) : (
        <ul className="space-y-4 mb-6 max-h-64 overflow-y-auto pr-1">
          {cartItems.map((item) => (
            <li key={item.id} className="flex gap-3">
              <div className="w-14 h-14 bg-muted flex-shrink-0 overflow-hidden">
                <img src={item.image} alt={item.name} className="w-full h-full object-cover" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-xs text-foreground leading-snug truncate">{item.name}</div>
                <div className="text-muted-foreground text-[10px] mt-0.5">Qty {item.quantity}</div>
              </div>
              <div className="font-black text-sm flex-shrink-0" style={{ fontFamily: "var(--font-display)" }}>
                ${(item.price * item.quantity).toFixed(2)}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 border-t border-border pt-4 text-sm">
        <div className="flex justify-between text-muted-foreground">
          <span>Subtotal</span><span>${subtotal.toFixed(2)}</span>
        </div>
        {promoApplied && (
          <div className="flex justify-between text-primary">
            <span>Promo (ALPINE10)</span><span>−${discount.toFixed(2)}</span>
          </div>
        )}
        <div className="flex justify-between text-muted-foreground">
          <span>Shipping</span>
          <span>{shippingCost === 0 ? <span className="text-primary">Free</span> : `$${shippingCost.toFixed(2)}`}</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>Tax (est.)</span><span>${tax.toFixed(2)}</span>
        </div>
        <div className="flex justify-between font-black text-foreground pt-2 border-t border-border text-base">
          <span style={{ fontFamily: "var(--font-display)" }}>Total</span>
          <span style={{ fontFamily: "var(--font-display)" }}>${total.toFixed(2)}</span>
        </div>
      </div>

      {step === "cart" && (
        <div className="mt-5">
          <div className="flex gap-2">
            <input
              type="text"
              value={promoCode}
              onChange={(e) => { setPromoCode(e.target.value.toUpperCase()); setPromoError(false); }}
              placeholder="Promo code"
              className="flex-1 bg-secondary border border-border text-foreground placeholder:text-muted-foreground px-3 py-2 text-xs outline-none focus:border-primary transition-colors uppercase"
            />
            <button
              onClick={applyPromo}
              className="bg-secondary border border-border px-3 py-2 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
            >
              Apply
            </button>
          </div>
          {promoApplied && <p className="text-primary text-[10px] mt-1.5 uppercase tracking-widest">✓ 10% discount applied</p>}
          {promoError && <p className="text-destructive text-[10px] mt-1.5">Invalid promo code. Try ALPINE10.</p>}
        </div>
      )}

      <div className="flex items-center gap-2 mt-5 text-muted-foreground text-[10px] uppercase tracking-widest">
        <Lock size={11} /> <span>Secure checkout · SSL encrypted</span>
      </div>
    </div>
  );

  // ── Step: Cart ──
  if (step === "cart") {
    return (
      <div className="min-h-screen bg-background">
        <div className="border-b border-border">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-2 text-[10px] text-muted-foreground uppercase tracking-widest">
            <Link to="/" className="hover:text-foreground transition-colors">Home</Link>
            <ChevronRight size={10} /><span className="text-foreground">Checkout</span>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10">
          <div className="flex items-center justify-between mb-10">
            <h1 className="text-4xl md:text-5xl font-black uppercase" style={{ fontFamily: "var(--font-display)" }}>
              Your Cart
            </h1>
            <StepIndicator current="cart" />
          </div>

          {cartItems.length === 0 ? (
            <div className="text-center py-28">
              <ShoppingBag size={48} className="mx-auto mb-5 text-muted-foreground opacity-25" />
              <p className="text-muted-foreground text-sm uppercase tracking-widest mb-6">Your cart is empty</p>
              <Link to="/" className="inline-flex items-center gap-2 bg-primary text-primary-foreground font-black uppercase tracking-widest px-6 py-3 text-xs hover:bg-primary/85 transition-colors">
                <ArrowLeft size={14} /> Continue Shopping
              </Link>
            </div>
          ) : (
            <div className="grid lg:grid-cols-3 gap-10">
              <div className="lg:col-span-2">
                <div className="border border-border divide-y divide-border">
                  {cartItems.map((item) => (
                    <div key={item.id} className="flex gap-5 p-5">
                      <Link to={`/product/${item.id}`} className="w-24 h-24 bg-muted flex-shrink-0 overflow-hidden block hover:opacity-80 transition-opacity">
                        <img src={item.image} alt={item.name} className="w-full h-full object-cover" />
                      </Link>
                      <div className="flex-1 min-w-0">
                        <Link to={`/product/${item.id}`}>
                          <h3 className="font-black uppercase text-sm hover:text-primary transition-colors" style={{ fontFamily: "var(--font-display)" }}>
                            {item.name}
                          </h3>
                        </Link>
                        <div className="text-muted-foreground text-xs mt-0.5">${item.price} each</div>
                        <div className="flex items-center gap-3 mt-3">
                          <div className="flex items-center border border-border">
                            <button onClick={() => updateQty(item.id, (quantities[item.id] ?? item.quantity) - 1)} className="px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors font-bold">−</button>
                            <span className="px-3 py-1.5 text-sm font-bold min-w-[2rem] text-center">{quantities[item.id] ?? item.quantity}</span>
                            <button onClick={() => updateQty(item.id, (quantities[item.id] ?? item.quantity) + 1)} className="px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors font-bold">+</button>
                          </div>
                          <button onClick={() => updateQty(item.id, 0)} className="text-muted-foreground hover:text-destructive transition-colors">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="font-black text-xl" style={{ fontFamily: "var(--font-display)" }}>
                          ${(item.price * (quantities[item.id] ?? item.quantity)).toFixed(2)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between mt-6">
                  <Link to="/" className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">
                    <ArrowLeft size={14} /> Continue Shopping
                  </Link>
                  <button
                    onClick={() => setStep("shipping")}
                    disabled={cartItems.length === 0}
                    className="bg-primary text-primary-foreground font-black uppercase tracking-widest px-8 py-3 text-xs hover:bg-primary/85 transition-colors disabled:opacity-40 flex items-center gap-2"
                  >
                    Proceed to Shipping <ChevronRight size={14} />
                  </button>
                </div>
              </div>
              <div><OrderSummary /></div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Step: Shipping ──
  if (step === "shipping") {
    return (
      <div className="min-h-screen bg-background">
        <div className="border-b border-border">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-2 text-[10px] text-muted-foreground uppercase tracking-widest">
            <Link to="/" className="hover:text-foreground transition-colors">Home</Link>
            <ChevronRight size={10} /><span className="text-foreground">Checkout</span>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10">
          <div className="flex items-center justify-between mb-10">
            <h1 className="text-4xl md:text-5xl font-black uppercase" style={{ fontFamily: "var(--font-display)" }}>Shipping</h1>
            <StepIndicator current="shipping" />
          </div>

          <div className="grid lg:grid-cols-3 gap-10">
            <div className="lg:col-span-2 space-y-8">
              {/* Contact */}
              <div>
                <h2 className="text-xl font-black uppercase mb-5" style={{ fontFamily: "var(--font-display)" }}>Contact Information</h2>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div><label className={labelCls}>First Name</label><input className={inputCls} value={ship.firstName} onChange={(e) => setShip({ ...ship, firstName: e.target.value })} placeholder="First name" /></div>
                  <div><label className={labelCls}>Last Name</label><input className={inputCls} value={ship.lastName} onChange={(e) => setShip({ ...ship, lastName: e.target.value })} placeholder="Last name" /></div>
                  <div><label className={labelCls}>Email Address</label><input type="email" className={inputCls} value={ship.email} onChange={(e) => setShip({ ...ship, email: e.target.value })} placeholder="your@email.com" /></div>
                  <div><label className={labelCls}>Phone</label><input type="tel" className={inputCls} value={ship.phone} onChange={(e) => setShip({ ...ship, phone: e.target.value })} placeholder="(555) 000-0000" /></div>
                </div>
              </div>

              {/* Address */}
              <div>
                <h2 className="text-xl font-black uppercase mb-5" style={{ fontFamily: "var(--font-display)" }}>Shipping Address</h2>
                <div className="space-y-4">
                  <div><label className={labelCls}>Street Address</label><input className={inputCls} value={ship.address} onChange={(e) => setShip({ ...ship, address: e.target.value })} placeholder="123 Main Street" /></div>
                  <div><label className={labelCls}>Apt / Suite <span className="text-muted-foreground/50">(optional)</span></label><input className={inputCls} value={ship.apt} onChange={(e) => setShip({ ...ship, apt: e.target.value })} placeholder="Apt, suite, unit, etc." /></div>
                  <div className="grid sm:grid-cols-3 gap-4">
                    <div className="sm:col-span-1"><label className={labelCls}>City</label><input className={inputCls} value={ship.city} onChange={(e) => setShip({ ...ship, city: e.target.value })} placeholder="City" /></div>
                    <div><label className={labelCls}>State</label>
                      <select className={inputCls} value={ship.state} onChange={(e) => setShip({ ...ship, state: e.target.value })}>
                        {US_STATES.map((s) => <option key={s}>{s}</option>)}
                      </select>
                    </div>
                    <div><label className={labelCls}>ZIP Code</label><input className={inputCls} value={ship.zip} onChange={(e) => setShip({ ...ship, zip: e.target.value })} placeholder="80301" /></div>
                  </div>
                  <div><label className={labelCls}>Country</label>
                    <select className={inputCls} value={ship.country} onChange={(e) => setShip({ ...ship, country: e.target.value })}>
                      {["United States", "Canada", "United Kingdom", "Australia", "Germany", "France", "Japan", "Other"].map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              {/* Shipping method */}
              <div>
                <h2 className="text-xl font-black uppercase mb-5" style={{ fontFamily: "var(--font-display)" }}>Shipping Method</h2>
                <div className="space-y-3">
                  {SHIPPING_OPTIONS.map((opt) => {
                    const cost = opt.id === "standard" && subtotal >= 75 ? 0 : opt.price;
                    return (
                      <label key={opt.id} className={`flex items-center gap-4 border p-4 cursor-pointer transition-colors ${selectedShipping === opt.id ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground"}`}>
                        <input type="radio" name="shipping" value={opt.id} checked={selectedShipping === opt.id} onChange={() => setSelectedShipping(opt.id)} className="accent-yellow-400" />
                        <div className="flex-1">
                          <div className="font-bold text-sm text-foreground">{opt.label}</div>
                          <div className="text-muted-foreground text-xs">{opt.time}</div>
                        </div>
                        <div className="font-black text-sm" style={{ fontFamily: "var(--font-display)" }}>
                          {cost === 0 ? <span className="text-primary">Free</span> : `$${cost.toFixed(2)}`}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between pt-4">
                <button onClick={() => setStep("cart")} className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">
                  <ArrowLeft size={14} /> Back to Cart
                </button>
                <button onClick={() => setStep("payment")} className="bg-primary text-primary-foreground font-black uppercase tracking-widest px-8 py-3 text-xs hover:bg-primary/85 transition-colors flex items-center gap-2">
                  Continue to Payment <ChevronRight size={14} />
                </button>
              </div>
            </div>
            <div><OrderSummary /></div>
          </div>
        </div>
      </div>
    );
  }

  // ── Step: Payment ──
  if (step === "payment") {
    return (
      <div className="min-h-screen bg-background">
        <div className="border-b border-border">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-2 text-[10px] text-muted-foreground uppercase tracking-widest">
            <Link to="/" className="hover:text-foreground transition-colors">Home</Link>
            <ChevronRight size={10} /><span className="text-foreground">Checkout</span>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10">
          <div className="flex items-center justify-between mb-10">
            <h1 className="text-4xl md:text-5xl font-black uppercase" style={{ fontFamily: "var(--font-display)" }}>Payment</h1>
            <StepIndicator current="payment" />
          </div>

          <div className="grid lg:grid-cols-3 gap-10">
            <div className="lg:col-span-2 space-y-8">
              {/* Shipping summary */}
              <div className="border border-border p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Shipping to</div>
                    <div className="text-sm font-semibold text-foreground">
                      {ship.firstName || "—"} {ship.lastName} · {ship.address}{ship.city ? `, ${ship.city}` : ""}{ship.state ? `, ${ship.state}` : ""} {ship.zip}
                    </div>
                  </div>
                  <button onClick={() => setStep("shipping")} className="text-primary text-xs font-bold uppercase tracking-widest hover:text-primary/80 transition-colors">Edit</button>
                </div>
              </div>

              {/* Card details */}
              <div>
                <h2 className="text-xl font-black uppercase mb-5" style={{ fontFamily: "var(--font-display)" }}>Card Details</h2>
                <div className="space-y-4">
                  <div><label className={labelCls}>Name on Card</label><input className={inputCls} value={pay.nameOnCard} onChange={(e) => setPay({ ...pay, nameOnCard: e.target.value })} placeholder="As it appears on the card" /></div>
                  <div><label className={labelCls}>Card Number</label><input className={inputCls} value={pay.cardNumber} onChange={(e) => setPay({ ...pay, cardNumber: formatCard(e.target.value) })} placeholder="1234 5678 9012 3456" maxLength={19} /></div>
                  <div className="grid grid-cols-2 gap-4">
                    <div><label className={labelCls}>Expiry</label><input className={inputCls} value={pay.expiry} onChange={(e) => setPay({ ...pay, expiry: formatExpiry(e.target.value) })} placeholder="MM/YY" maxLength={5} /></div>
                    <div><label className={labelCls}>CVV</label><input className={inputCls} value={pay.cvv} onChange={(e) => setPay({ ...pay, cvv: e.target.value.replace(/\D/g, "").slice(0, 4) })} placeholder="•••" maxLength={4} /></div>
                  </div>
                </div>
              </div>

              {/* Billing address */}
              <div>
                <h2 className="text-xl font-black uppercase mb-5" style={{ fontFamily: "var(--font-display)" }}>Billing Address</h2>
                <label className="flex items-center gap-3 mb-5 cursor-pointer">
                  <input type="checkbox" checked={pay.sameAsShipping} onChange={(e) => setPay({ ...pay, sameAsShipping: e.target.checked })} className="accent-yellow-400 w-4 h-4" />
                  <span className="text-sm text-muted-foreground">Same as shipping address</span>
                </label>
                {!pay.sameAsShipping && (
                  <div className="space-y-4">
                    <div><label className={labelCls}>Street Address</label><input className={inputCls} value={pay.billingAddress} onChange={(e) => setPay({ ...pay, billingAddress: e.target.value })} placeholder="123 Main Street" /></div>
                    <div className="grid sm:grid-cols-3 gap-4">
                      <div className="sm:col-span-1"><label className={labelCls}>City</label><input className={inputCls} value={pay.billingCity} onChange={(e) => setPay({ ...pay, billingCity: e.target.value })} placeholder="City" /></div>
                      <div><label className={labelCls}>State</label>
                        <select className={inputCls} value={pay.billingState} onChange={(e) => setPay({ ...pay, billingState: e.target.value })}>
                          {US_STATES.map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </div>
                      <div><label className={labelCls}>ZIP</label><input className={inputCls} value={pay.billingZip} onChange={(e) => setPay({ ...pay, billingZip: e.target.value })} placeholder="80301" /></div>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-4">
                <button onClick={() => setStep("shipping")} className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">
                  <ArrowLeft size={14} /> Back to Shipping
                </button>
                <button
                  onClick={() => setStep("confirmation")}
                  className="bg-primary text-primary-foreground font-black uppercase tracking-widest px-8 py-3 text-xs hover:bg-primary/85 transition-colors flex items-center gap-2"
                >
                  <Lock size={13} /> Place Order — ${total.toFixed(2)}
                </button>
              </div>
            </div>
            <div><OrderSummary /></div>
          </div>
        </div>
      </div>
    );
  }

  // ── Step: Confirmation ──
  const orderNumber = `ABE-2026-${Math.floor(10000 + Math.random() * 90000)}`;
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-24">
      <div className="max-w-lg w-full text-center">
        <div className="w-16 h-16 bg-primary rounded-full flex items-center justify-center mx-auto mb-6">
          <Check size={28} className="text-primary-foreground" />
        </div>
        <div className="text-primary text-[10px] font-bold uppercase tracking-[0.2em] mb-3">Order Confirmed</div>
        <h1 className="text-5xl font-black uppercase mb-4" style={{ fontFamily: "var(--font-display)" }}>
          You're All Set
        </h1>
        <p className="text-muted-foreground mb-2">
          Thank you for your order. A confirmation has been sent to{" "}
          <span className="text-foreground font-semibold">{ship.email || "your email"}</span>.
        </p>
        <div className="border border-border p-5 my-8 text-left space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Order Number</span>
            <span className="font-black text-foreground" style={{ fontFamily: "var(--font-display)" }}>{orderNumber}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Shipping Method</span>
            <span className="text-foreground font-semibold">{shippingOpt.label}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Estimated Delivery</span>
            <span className="text-primary font-semibold">{shippingOpt.time}</span>
          </div>
          <div className="flex justify-between text-sm border-t border-border pt-3">
            <span className="text-muted-foreground">Total Charged</span>
            <span className="font-black text-foreground" style={{ fontFamily: "var(--font-display)" }}>${total.toFixed(2)}</span>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link to="/support/track-order" className="inline-flex items-center justify-center gap-2 border border-border text-foreground font-bold uppercase tracking-widest px-6 py-3 text-xs hover:border-primary hover:text-primary transition-colors">
            Track Order
          </Link>
          <Link to="/" className="inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground font-black uppercase tracking-widest px-6 py-3 text-xs hover:bg-primary/85 transition-colors">
            Continue Shopping
          </Link>
        </div>
      </div>
    </div>
  );
}
