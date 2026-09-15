import type { CSSProperties } from 'react'
import {
  listLegalMoves,
  type Board,
  type Coord,
  type Stone,
} from '../game/index.ts'
import type { LastMove } from '../session/index.ts'
import { GAME_CONFIG } from '../game/config.ts'
import './Board.css'

type BoardViewProps = {
  board: Board
  lastMove: LastMove | null
  showLegalMoves: boolean
  interactive: boolean
  onCellClick: (row: number, col: number) => void
}

export function BoardView({
  board,
  lastMove,
  showLegalMoves,
  interactive,
  onCellClick,
}: BoardViewProps) {
  const legal: Coord[] = showLegalMoves
    ? listLegalMoves(board, GAME_CONFIG.playerStone)
    : []
  const legalSet = new Set(legal.map((m) => `${m.row},${m.col}`))
  const size = board.length
  const colLabels = Array.from({ length: size }, (_, i) =>
    String.fromCharCode(65 + i),
  )

  return (
    <div
      className="board-shell"
      style={{ '--board-size': size } as CSSProperties}
    >
      <div className="board-col-labels" aria-hidden="true">
        {colLabels.map((label) => (
          <span key={`top-${label}`}>{label}</span>
        ))}
      </div>
      <div className="board-row-labels" aria-hidden="true">
        {board.map((_, row) => (
          <span key={`left-${row}`}>{row + 1}</span>
        ))}
      </div>
      <div className="board" role="grid" aria-label="リバーシ盤">
        {board.map((rowCells, row) =>
          rowCells.map((cell, col) => {
            const key = `${row},${col}`
            const isLegal = legalSet.has(key)
            const isLast =
              lastMove !== null && lastMove.row === row && lastMove.col === col
            return (
              <button
                key={key}
                type="button"
                className={[
                  'cell',
                  isLegal ? 'cell-legal' : '',
                  isLast ? 'cell-last' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                disabled={!interactive || !isLegal}
                aria-label={`${row + 1}行${col + 1}列${cellLabel(cell)}${
                  isLegal ? ' 合法手' : ''
                }`}
                onClick={() => {
                  if (interactive && isLegal) onCellClick(row, col)
                }}
              >
                {cell ? (
                  <span
                    key={cell}
                    className={`stone stone-${cell}${isLast ? ' stone-last' : ''}`}
                  />
                ) : isLegal ? (
                  <span className="legal-dot" />
                ) : null}
              </button>
            )
          }),
        )}
      </div>
      <div className="board-row-labels board-row-labels-end" aria-hidden="true">
        {board.map((_, row) => (
          <span key={`right-${row}`}>{row + 1}</span>
        ))}
      </div>
      <div className="board-col-labels board-col-labels-end" aria-hidden="true">
        {colLabels.map((label) => (
          <span key={`bottom-${label}`}>{label}</span>
        ))}
      </div>
    </div>
  )
}

function cellLabel(cell: Stone | null): string {
  if (cell === 'black') return ' 黒'
  if (cell === 'white') return ' 白'
  return ' 空き'
}
