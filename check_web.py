import asyncio, pathlib, sys
from playwright.async_api import async_playwright
PAGES = ['landing','panel']
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--no-sandbox'])
        for w in (390, 768, 1440):
            ctx = await b.new_context(viewport={'width': w, 'height': 900})
            pg = await ctx.new_page()
            errs = []
            pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            pg.on('pageerror', lambda e: errs.append(str(e)))
            for name in PAGES:
                await pg.goto(f'file://' + str(pathlib.Path(__file__).resolve().parent / 'web' / name / 'index.html'), wait_until='load')
                await pg.wait_for_timeout(700)
                over = await pg.evaluate('document.documentElement.scrollWidth - window.innerWidth')
                print(f'{name:8} {w:4}  scroll+{over}  errores={len(errs)}')
                errs.clear()
            await ctx.close()
        await b.close()
asyncio.run(main())
