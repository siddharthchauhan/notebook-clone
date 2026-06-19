"""Static read/write analysis of code cells — the basis for reactive execution.

Reactive mode re-runs a block's dependents when it changes. A block's
dependencies fall out of which names it *reads* versus *writes*: cell B depends
on cell A when B reads a name that A writes. We approximate reads/writes with a
module-level AST walk:

* **writes** — names bound at module scope (assignments, ``def``/``class``,
  imports, ``for``/``with`` targets);
* **reads** — names loaded anywhere, minus this cell's own writes and builtins.

Over-approximating reads is safe: it only makes reactivity re-run a touch more.
Names bound *inside* a function/class are local, so they're not module writes —
but a global referenced inside a function still counts as a read.
"""

from __future__ import annotations

import ast
import builtins

from fastapi import APIRouter
from pydantic import BaseModel

_BUILTINS = set(dir(builtins)) | {"__name__", "__file__", "__doc__", "__builtins__"}


class _Analyzer(ast.NodeVisitor):
    def __init__(self) -> None:
        self.writes: set[str] = set()
        self.loads: set[str] = set()
        # Stack of local-name sets for enclosing function/class/comprehension
        # scopes. Empty stack == module scope, where binds become writes.
        self._scopes: list[set[str]] = []

    def _bind(self, name: str) -> None:
        if self._scopes:
            self._scopes[-1].add(name)  # local to a function/comprehension
        else:
            self.writes.add(name)  # module-level write

    def _is_local(self, name: str) -> bool:
        return any(name in s for s in self._scopes)

    @staticmethod
    def _arg_names(args: ast.arguments) -> list[str]:
        names = [a.arg for a in (*args.posonlyargs, *args.args, *args.kwonlyargs)]
        if args.vararg:
            names.append(args.vararg.arg)
        if args.kwarg:
            names.append(args.kwarg.arg)
        return names

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._bind(node.name)
        # Defaults and decorators evaluate in the *enclosing* scope.
        for d in (*node.args.defaults, *node.args.kw_defaults):
            if d is not None:
                self.visit(d)
        for dec in node.decorator_list:
            self.visit(dec)
        self._scopes.append(set(self._arg_names(node.args)))
        for stmt in node.body:
            self.visit(stmt)
        self._scopes.pop()

    visit_AsyncFunctionDef = visit_FunctionDef  # type: ignore[assignment]

    def visit_Lambda(self, node: ast.Lambda) -> None:
        for d in (*node.args.defaults, *node.args.kw_defaults):
            if d is not None:
                self.visit(d)
        self._scopes.append(set(self._arg_names(node.args)))
        self.visit(node.body)
        self._scopes.pop()

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._bind(node.name)
        for dec in node.decorator_list:
            self.visit(dec)
        self._scopes.append(set())
        for stmt in node.body:
            self.visit(stmt)
        self._scopes.pop()

    def _visit_comp(self, node: ast.AST) -> None:
        # Comprehensions get their own scope; bind targets before visiting the
        # element so the loop var isn't mistaken for a read.
        self._scopes.append(set())
        for gen in node.generators:  # type: ignore[attr-defined]
            self.visit(gen.target)
            self.visit(gen.iter)
            for cond in gen.ifs:
                self.visit(cond)
        if isinstance(node, ast.DictComp):
            self.visit(node.key)
            self.visit(node.value)
        else:
            self.visit(node.elt)  # type: ignore[attr-defined]
        self._scopes.pop()

    visit_ListComp = _visit_comp  # type: ignore[assignment]
    visit_SetComp = _visit_comp  # type: ignore[assignment]
    visit_DictComp = _visit_comp  # type: ignore[assignment]
    visit_GeneratorExp = _visit_comp  # type: ignore[assignment]

    def visit_Global(self, node: ast.Global) -> None:
        # `global x` makes assignments to x module-level writes.
        self.writes.update(node.names)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load):
            if not self._is_local(node.id):
                self.loads.add(node.id)
        else:  # Store / Del
            self._bind(node.id)

    def visit_Import(self, node: ast.Import) -> None:
        for a in node.names:
            self._bind((a.asname or a.name).split(".")[0])

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        for a in node.names:
            if a.name != "*":
                self._bind(a.asname or a.name)


def analyze_source(source: str) -> tuple[list[str], list[str]]:
    """Return ``(reads, writes)`` for one cell's source (empty on syntax error)."""
    try:
        tree = ast.parse(source or "")
    except SyntaxError:
        return [], []
    a = _Analyzer()
    a.visit(tree)
    reads = sorted(a.loads - a.writes - _BUILTINS)
    writes = sorted(a.writes - _BUILTINS)
    return reads, writes


# --------------------------------------------------------------------------- #
# endpoint
# --------------------------------------------------------------------------- #
class _CellIn(BaseModel):
    id: str
    source: str = ""


class AnalyzeRequest(BaseModel):
    cells: list[_CellIn]


class CellDeps(BaseModel):
    id: str
    reads: list[str]
    writes: list[str]


class AnalyzeResponse(BaseModel):
    cells: list[CellDeps]


router = APIRouter(prefix="/api/analyze", tags=["analysis"])


@router.post("", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    """Read/write sets per code cell, so the client can build a dependency graph."""
    cells = []
    for c in req.cells:
        reads, writes = analyze_source(c.source)
        cells.append(CellDeps(id=c.id, reads=reads, writes=writes))
    return AnalyzeResponse(cells=cells)
