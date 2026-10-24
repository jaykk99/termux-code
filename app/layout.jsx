import './globals.css';

export const metadata = {
  title: 'termux-code',
  description: 'A coding agent that runs in Termux. This site is the sign-in gate and the phone connect command.',
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
              <a href="/">connect</a>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
