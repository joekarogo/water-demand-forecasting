import { createRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from './session';
import TopBar from './layout/TopBar';
import { fakeResponse, SAMPLE_SESSION } from './testFetchMock';

beforeEach(() => {
  global.fetch = jest.fn(() => Promise.resolve(fakeResponse({ status: 200, body: SAMPLE_SESSION })));
});

function renderTopBar() {
  const menuBtnRef = createRef();
  return render(
    <MemoryRouter>
      <SessionProvider>
        <TopBar title="Demand Forecast" onMenuClick={() => {}} menuBtnRef={menuBtnRef} navOpen={false} />
      </SessionProvider>
    </MemoryRouter>
  );
}

test('the user menu opens on click and shows account links and sign out', async () => {
  renderTopBar();
  const trigger = await screen.findByRole('button', { name: /ada lovelace/i });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');

  await userEvent.click(trigger);

  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: 'My account' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Help' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Privacy' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'About' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
});

test('Escape closes the user menu and returns focus to the trigger button', async () => {
  renderTopBar();
  const trigger = await screen.findByRole('button', { name: /ada lovelace/i });

  await userEvent.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');

  await userEvent.keyboard('{Escape}');

  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  expect(trigger).toHaveFocus();
});
