import { expect, test } from "@playwright/test";

const API = process.env.API_BASE ?? "http://127.0.0.1:3001";
const stamp = Date.now().toString(36);

async function loginAs(page: Parameters<Parameters<typeof test>[1]>[0], email: string): Promise<void> {
  const started = await page.request.post(`${API}/auth/magic/start`, { data: { email } });
  expect(started.ok()).toBeTruthy();
  const body = (await started.json()) as { devToken?: string };
  expect(body.devToken).toBeTruthy();
  await page.goto(`/login?token=${encodeURIComponent(body.devToken as string)}`);
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible({ timeout: 15000 });
}

test("login page renders magic form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send magic link" })).toBeVisible();
});

test("magic login lands on history", async ({ page }) => {
  const email = `${stamp}-pw@example.com`;
  await loginAs(page, email);
  await expect(page.getByRole("navigation").getByText(email)).toBeVisible();
});

test("devices page registers a C6", async ({ page }) => {
  await loginAs(page, `${stamp}-pwdev@example.com`);
  await page.goto("/devices");
  const sn = `PW-${stamp}`;
  await page.getByPlaceholder("Serial number").fill(sn);
  await page.getByRole("button", { name: "Register C6" }).click();
  await expect(page.getByText(sn)).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Activate" }).first().click();
  await expect(page.getByText("active").first()).toBeVisible({ timeout: 15000 });
});

test("teams page shows self as member", async ({ page }) => {
  await loginAs(page, `${stamp}-pwteam@example.com`);
  await page.goto("/teams");
  await expect(page.getByRole("cell", { name: `${stamp}-pwteam@example.com` })).toBeVisible({ timeout: 15000 });
});

test("map page loads with dawarich section", async ({ page }) => {
  await loginAs(page, `${stamp}-pwmap@example.com`);
  await page.goto("/map");
  await expect(page.getByRole("heading", { name: "Map" })).toBeVisible();
  await expect(page.getByText("Dawarich overlay")).toBeVisible();
});

test("logout returns to login", async ({ page }) => {
  await loginAs(page, `${stamp}-pwout@example.com`);
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page.getByRole("button", { name: "Send magic link" })).toBeVisible({ timeout: 15000 });
});
