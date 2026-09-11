import './globals.css';

export const metadata = {
  title: 'termux-code',
  description: 'A coding agent that runs in Termux, with your own models behind it.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="masthead">
            <span className="caret">›</span>
            <h1>termux-code</h1>
            <nav>
              <a href="/">home</a> <a href="/settings">settings</a>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
