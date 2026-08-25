**free
ctl-opt dftactgrp(*no) actgrp(*caller) option(*srcstmt:*nodebugio);

dcl-f ITGRIDD workstn;

RESULT = 'Grid defined';
write GRIDCLR;
write GRIDON;

dou *in03;
    exfmt MAIN;

    if *in05;
        write GRIDCLR;
        RESULT = 'Grid cleared';
        *in05 = *off;
    elseif *in06;
        write GRIDON;
        RESULT = 'Grid redrawn';
        *in06 = *off;
    endif;
enddo;

write GRIDCLR;
*inlr = *on;
return;
