import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '@/api/client'
import { ActivityTrendModule } from './activity-trend'

type ChartPoint = { at: string; online: number; sessions: number; approved: number; time?: string }
const ChartContext = React.createContext<{ data: ChartPoint[]; xKey: string; selected: number }>({
  data: [],
  xKey: 'time',
  selected: -1,
})

vi.mock('recharts', () => {
  function XAxis({ dataKey }: { dataKey: string }) {
    return <div data-testid="x-axis" data-key={dataKey} />
  }
  return {
    Area: () => null,
    CartesianGrid: () => null,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    XAxis,
    YAxis: () => null,
    Tooltip: ({ labelFormatter }: { labelFormatter?: (label: string) => React.ReactNode }) => {
      const { data, xKey, selected } = React.useContext(ChartContext)
      if (selected < 0) return null
      const point = data[selected]!
      const label = String(point[xKey as keyof ChartPoint])
      const resolved = data.find((candidate) => candidate[xKey as keyof ChartPoint] === label)!
      return (
        <output data-testid="chart-tooltip">
          {labelFormatter?.(label)}: {resolved.sessions}
        </output>
      )
    },
    AreaChart: ({ data, children }: { data: ChartPoint[]; children: React.ReactNode }) => {
      const [selected, setSelected] = React.useState(-1)
      const axis = React.Children.toArray(children).find(
        (child) => React.isValidElement<{ dataKey?: string }>(child) && child.type === XAxis,
      )
      const xKey = React.isValidElement<{ dataKey?: string }>(axis)
        ? (axis.props.dataKey ?? 'time')
        : 'time'
      return (
        <ChartContext.Provider value={{ data, xKey, selected }}>
          {children}
          {data.map(
            (point, index) =>
              point.sessions > 0 && (
                <button
                  key={point.at}
                  type="button"
                  data-testid="hover-bump"
                  onMouseEnter={() => setSelected(index)}
                />
              ),
          )}
        </ChartContext.Provider>
      )
    },
  }
})

const points = [
  { at: '2026-11-12T12:00:00.000Z', approved: 10, online: 3, sessions: 0 },
  { at: '2026-11-12T13:00:00.000Z', approved: 10, online: 4, sessions: 5 },
]

describe('ActivityTrendModule tooltip', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(api, 'GET').mockResolvedValue({
      data: { range: '24h', step_seconds: 300, points },
      response: new Response(),
    } as never)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the later nonzero point when same-day points are hovered on 7d', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ActivityTrendModule />
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: '7d' }))
    await waitFor(() => expect(screen.getByTestId('x-axis')).toHaveAttribute('data-key', 'at'))
    fireEvent.mouseEnter(screen.getByTestId('hover-bump'))
    const tooltip = await screen.findByTestId('chart-tooltip')
    expect(tooltip).toHaveTextContent('Nov 12')
    expect(tooltip.textContent).toMatch(/\d{1,2}:\d{2}/)
    expect(tooltip).toHaveTextContent(': 5')
  })
})
