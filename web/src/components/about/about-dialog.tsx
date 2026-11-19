import changelogText from '../../../../CHANGELOG.md?raw'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { currentVersion, parseChangelog } from './changelog'

const releases = parseChangelog(changelogText)
const version = currentVersion(releases)

function renderItem(item: string) {
  return item.split(/(`[^`]+`)/g).map((part, index) =>
    part.startsWith('`') && part.endsWith('`') ? (
      <code key={index} className="font-mono text-xs">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  )
}

export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>About Ferricade</DialogTitle>
          <DialogDescription className="sr-only">
            About Ferricade and its release history
          </DialogDescription>
        </DialogHeader>
        <Tabs key={open ? 'open' : 'closed'} defaultValue="about">
          <TabsList aria-label="About sections">
            <TabsTrigger value="about">About</TabsTrigger>
            <TabsTrigger value="changelog">Changelog</TabsTrigger>
          </TabsList>
          <TabsContent value="about" className="space-y-3 text-sm leading-relaxed">
            <p>
              Version <span className="font-mono">{version}</span>
            </p>
            <p>
              Ferricade is a self-hosted admin console for RustDesk. It runs next to unmodified hbbs
              and hbbr servers and is the API server for stock RustDesk clients.
            </p>
            <p>
              Devices report in and wait for approval. The console shows which devices are online,
              gives you rustdesk:// links to connect, and records every admin action in an
              append-only audit log.
            </p>
            <p>Ferricade is not affiliated with or endorsed by RustDesk.</p>
          </TabsContent>
          <TabsContent value="changelog" className="max-h-[60vh] overflow-y-auto space-y-4 pr-1">
            {releases.map((release, index) => (
              <details
                key={`${release.version}-${release.date ?? 'unreleased'}`}
                data-slot="changelog-release"
                open={index === 0}
                className="rounded-md border border-border px-3 py-2"
              >
                <summary className="cursor-pointer text-sm font-medium">
                  <span className="font-mono">{release.version}</span>
                  {release.date ? (
                    <span className="text-muted-foreground"> · {release.date}</span>
                  ) : null}
                </summary>
                <div className="space-y-3 pt-3">
                  {release.sections.map((section) => (
                    <section key={section.heading}>
                      <h3 className="text-xs font-semibold text-muted-foreground">
                        {section.heading}
                      </h3>
                      <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
                        {section.items.map((item, itemIndex) => (
                          <li key={itemIndex}>{renderItem(item)}</li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </details>
            ))}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
