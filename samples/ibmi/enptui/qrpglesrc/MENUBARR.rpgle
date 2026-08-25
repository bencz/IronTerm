**free
ctl-opt option(*nodebugio) dftactgrp(*no) actgrp(*new);

dcl-f MENUBARD workstn;

dcl-pr RunCommand extpgm('QCMDEXC');
    command char(32702) const options(*varsize);
    length packed(15: 5) const;
end-pr;

dcl-s command varchar(32702);

FIGLET =
      '  _ )              |    |        \  |            |   _)       '
    + '  _ \   _ \   _ \   _|    \     |\/ |   _` |   _| _|  |    \ '
    + ' ___/ \___/ \___/ \__| _| _|   _|  _| \__,_| _| \__| _| _| _|'
    + '                                                            '
    + '                         Menu Bar validation                '
    + '                         IronTerm & Friends                 ';
LINE77 = *all' ';

dou *inkc;
    TIMEUSA = %char(%time(): *usa);
    DATEUSA = %char(%date(): *mdy);
    write S1CMD;
    exfmt FMT01;

    select;
    when PULL = 1;
        command = 'DSPMSG';
    when PULL = 2;
        command = 'DSPJOBLOG';
    when PULL = 3;
        command = 'DSPJOB';
    when PULL = 21;
        command = 'WRKSPLF';
    when PULL = 23;
        command = 'WRKLNK';
    when PULL = 24;
        command = 'WRKUSRJOB';
    other;
        clear command;
    endsl;

    if command <> '';
        RunCommand(command: %len(command));
        clear command;
        clear PULL;
    endif;
enddo;

*inlr = *on;
return;
