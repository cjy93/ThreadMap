import { ManualContent } from '@/ui/Manual';
import { ThemeToggle } from '@/ui/ThemeToggle';

export const metadata = { title: 'ThreadMap user manual' };

export default function ManualPage() {
  return (
    <main className="landing">
      <div className="sky" aria-hidden />
      <div className="landing-top">
        <a href="/" className="brand" style={{ textDecoration: 'none' }}>
          Thread<em>Map</em>
        </a>
        <ThemeToggle />
      </div>
      <div className="kicker">Help</div>
      <h1>User manual</h1>
      <div className="card">
        <ManualContent />
      </div>
    </main>
  );
}
