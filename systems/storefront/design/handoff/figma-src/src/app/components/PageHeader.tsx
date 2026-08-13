import { Link } from "react-router";
import { ChevronRight } from "lucide-react";

interface Crumb {
  label: string;
  to?: string;
}

interface PageHeaderProps {
  crumbs: Crumb[];
  title: string;
  subtitle?: string;
  eyebrow?: string;
  image?: string;
}

export default function PageHeader({ crumbs, title, subtitle, eyebrow, image }: PageHeaderProps) {
  return (
    <>
      <div className="border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-2 text-[10px] text-muted-foreground uppercase tracking-widest flex-wrap">
          {crumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-2">
              {i > 0 && <ChevronRight size={10} />}
              {crumb.to ? (
                <Link to={crumb.to} className="hover:text-foreground transition-colors">
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-foreground">{crumb.label}</span>
              )}
            </span>
          ))}
        </div>
      </div>

      <div className={`relative overflow-hidden ${image ? "h-56 md:h-72" : "py-16 md:py-20"} bg-secondary/20 border-b border-border`}>
        {image && (
          <>
            <img src={image} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover opacity-20" />
            <div className="absolute inset-0 bg-gradient-to-r from-background/95 via-background/70 to-transparent" />
          </>
        )}
        <div className={`relative z-10 max-w-7xl mx-auto px-4 sm:px-6 ${image ? "h-full flex flex-col justify-center" : ""}`}>
          {eyebrow && (
            <div className="text-primary text-[10px] font-bold uppercase tracking-[0.2em] mb-3">{eyebrow}</div>
          )}
          <h1
            className="text-5xl md:text-7xl font-black uppercase leading-none text-foreground"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="text-muted-foreground mt-4 max-w-xl text-base leading-relaxed">{subtitle}</p>
          )}
        </div>
      </div>
    </>
  );
}
