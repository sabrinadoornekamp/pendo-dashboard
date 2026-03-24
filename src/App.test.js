import { render, screen } from '@testing-library/react';
import App from './App';

test('dashboard route shows product title', () => {
  render(<App />);
  expect(
    screen.getByRole('heading', { name: /therapieland user flow insights/i })
  ).toBeInTheDocument();
});

test('dashboard shows empty message when no local data', () => {
  render(<App />);
  expect(screen.getAllByText(/nog geen data beschikbaar/i).length).toBeGreaterThan(0);
});
