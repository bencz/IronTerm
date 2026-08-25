**free
ctl-opt dftactgrp(*no) actgrp(*caller);

dcl-pi FIGLET05R extpgm('FIGLET05R');
  key char(15) const;
  rows packed(2: 0) const;
  cols packed(3: 0) const;
  art char(1440);
end-pi;

dcl-s row char(65) dim(5);
dcl-s index int(10);
dcl-s width int(10);

clear art;
row(1) = '  ___                  ____';
row(2) = ' |_ _| ___ ___        / ___|_ __ ___  __ _ _ __ ___';
row(3) = '  | | / __/ _ \      | |   | ''__/ _ \/ _` | ''_ ` _ \';
row(4) = '  | || (_|  __/      | |___| | |  __/ (_| | | | | | |';
row(5) = ' |___|\___\___|       \____|_|  \___|\__,_|_| |_| |_|';
width = %min(%size(row(1)): %int(cols));
for index = 1 to %min(%elem(row): %int(rows));
  %subst(art: ((index - 1) * %int(cols)) + 1: width) = %subst(row(index): 1: width);
endfor;

*inlr = *on;
