import type { Metadata } from 'next';
import { Albert_Sans, Antonio, Fraunces } from 'next/font/google';
import '@xyflow/react/dist/style.css';
import './globals.css';
import { themeBootScript } from '@/ui/theme';

const fraunces = Fraunces({ subsets: ['latin'], axes: ['opsz'], style: ['normal', 'italic'], variable: '--font-fraunces', display: 'swap' });
const albert = Albert_Sans({ subsets: ['latin'], variable: '--font-albert', display: 'swap' });
const antonio = Antonio({ subsets: ['latin'], variable: '--font-antonio', display: 'swap' });

export const metadata: Metadata = {
  title: 'ThreadMap',
  description: 'Navigable knowledge maps of selected WhatsApp conversations, with exact sources.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="night" className={`${fraunces.variable} ${albert.variable} ${antonio.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
